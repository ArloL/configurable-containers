import { Builder, type WebDriver } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { zipSync } from "fflate";
import { startServer, BEACON_PATH, type TestServer } from "./server";
import { buildExtension } from "./build-extension";
import { claimProfileDir, reapProfile } from "./reaper";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// `mac` is the upstream Multi-Account Containers, loaded UNBUILT: its src/ is
// plain JS with no bundle step (its own build is just `web-ext build -s src/`).
const EXT_DIRS: Record<"probe" | "cc" | "mac", string> = {
  probe: path.resolve(HERE, "../extensions/probe"),
  cc: path.resolve(HERE, "../extensions/cc"),
  mac: path.resolve(HERE, "../mac/src"),
};

// MAC's own extension id (mac/src/manifest.json). CC addresses it by this id for the
// getAssignment handshake — see MAC_ID in src/engine/engine.ts, which must match.
export const MAC_EXTENSION_ID = "@testpilot-containers";

// The beacon the seeded MAC assignment reports itself through (harness/server.ts). A
// background page's storage is in no DOM, so a fetch to the test server is the only way Node
// learns the seeding finished — and launch() must know before a test navigates.
const MAC_ASSIGNED_BEACON = "mac-assigned";

// CC's extension id (must match extensions/cc/manifest.json) and a FIXED uuid for its
// moz-extension:// origin, pinned via the extensions.webextensions.uuids pref in launch().
// Unpinned, the origin is random per profile and no test could address an extension page.
export const CC_EXTENSION_ID = "configurable-containers@k5d.de";
export const CC_EXTENSION_UUID = "5c5b6d4e-9f3a-4a21-8b7c-1d2e3f4a5b6c";

// The probe's own id, from extensions/probe/manifest.json. CC's e2e build echoes its
// notifications here; buildExtension defaults this off for every shipped build.
export const PROBE_EXTENSION_ID = "probe@configurable-containers.test";

export function ccExtensionUrl(pagePath: string): string {
  return `moz-extension://${CC_EXTENSION_UUID}/${pagePath}`;
}

// Resolved to loopback by the prefs launch() sets, so no DNS is involved.
const DEFAULT_LOCAL_DOMAINS = [
  "work.example", "nomatch.example", "redirect.example", "figma.example", "youtube.example",
  "hop.example",
];

export interface Session {
  driver: WebDriver;
  serverUrl: string;
  // The profile directory this browser was launched into: the token the reaper identifies
  // its processes by. Exposed so a test can assert nothing is left running under it.
  profileDir: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  extensions?: ("probe" | "cc" | "mac")[];
  // Seed a MAC site assignment (requires the "mac" extension). A HOST, not a url: the test
  // server's port is only known inside launch(), and MAC keys assignments by hostname+port.
  // userContextId is the number in a cookieStoreId — "1" is Firefox's built-in Personal.
  macAssign?: { host: string; userContextId: string };
  ccGraceMs?: number; // grace passed to the cc build (default: production 300000)
  ccRedirectorDelayMs?: number; // redirector-close delay (default: production 2000)
  headless?: boolean; // default true; set false for manual/interactive testing
  configYaml?: string; // override the bundled config (manual launcher passes the real one)
  localDomains?: string[] | null; // domains resolved to loopback; default = test domains, null = none
  // Page the first tab opens on. Marionette otherwise starts at about:blank, which
  // auto-temp ignores by design — pass "about:newtab" to exercise the startup sweep.
  startupUrl?: string;
}

// installAddon wants a file, not a directory. fflate rather than a `zip` binary, as
// scripts/package.ts does.
function zipDir(
  dir: string,
  transform?: (entries: Record<string, Uint8Array>) => void,
): { xpiPath: string; cleanup: () => void } {
  const out = mkdtempSync(path.join(tmpdir(), "cc-e2e-xpi-"));
  const xpiPath = path.join(out, "addon.xpi");

  const entries: Record<string, Uint8Array> = {};
  const walk = (from: string, prefix = "") => {
    for (const e of readdirSync(from, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue; // matches the old `-x .*`
      const full = path.join(from, e.name);
      if (e.isDirectory()) walk(full, `${prefix}${e.name}/`);
      else entries[`${prefix}${e.name}`] = readFileSync(full);
    }
  };
  walk(dir);
  transform?.(entries);

  writeFileSync(xpiPath, zipSync(entries, { level: 9 }));
  return { xpiPath, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

// MAC's manifest declares `default_locale: "en"`, but mac/src/_locales is a nested submodule
// we deliberately do not check out, and Firefox then rejects the add-on outright ("Extension
// is invalid"). Every string it supplies is display text the tested logic never reads, so the
// harness synthesises the handful of keys the manifest interpolates, which keeps CI light
function ensureMacLocale(entries: Record<string, Uint8Array>): void {
  const file = "_locales/en/messages.json";
  if (entries[file]) return;
  const keys = [
    "extensionDescription", "alwaysOpenSiteInContainer", "containerShortcut",
    "openContainerPanel", "reopenInContainerShortcut", "sortTabsByContainer",
  ];
  const messages = Object.fromEntries(keys.map((k) => [k, { message: k }]));
  entries[file] = new TextEncoder().encode(JSON.stringify(messages));
}

// Seed a MAC site assignment by appending one script to MAC's background PAGE inside the
// .xpi we build. The checkout on disk is never touched; the rewrite is on the in-memory zip
// entries, like CC's build-time config injection.
//
// This stands in for the one step of a real MAC setup that cannot be scripted: an assignment
// is created from MAC's browser-action popup or context menu, both chrome UI Selenium cannot
// drive, and MAC's external API has `getAssignment` but no setter. What is under test stays
// stock MAC — the seeding calls MAC's OWN `storageArea.set`, so the key format lives in MAC's
// code, and CC reads it back through MAC's real `getAssignment`.
function injectMacAssignment(
  entries: Record<string, Uint8Array>,
  assign: { url: string; userContextId: string; beaconUrl: string },
): void {
  const page = "js/background/index.html";
  const hook = "js/background/cc-harness-assign.js";
  const html = new TextDecoder().decode(entries[page]);
  if (!html.includes("</body>")) throw new Error(`MAC background page shape changed: no </body> in ${page}`);

  entries[hook] = new TextEncoder().encode(
    `// Injected by the CC e2e harness (harness/firefox.ts). Not part of upstream MAC.\n` +
      `(async () => {\n` +
      `  const url = ${JSON.stringify(assign.url)};\n` +
      `  const userContextId = ${JSON.stringify(assign.userContextId)};\n` +
      `  for (let i = 0; i < 100; i++) {\n` +
      `    try {\n` +
      // The container MUST resolve before the assignment is written. MAC deletes an
      // assignment whose container it cannot get and lets the page load uncontained
      // (assignManager.js, "The container we have in the assignment map isn't present any
      // more"). CC has deferred by then, so nothing routes the tab and the assignment is
      // gone for good — the test fails as "no container tab" for its whole timeout. Firefox
      // provisions even built-in containers lazily, so on a cold profile this get is what
      // loses the race.
      `      await browser.contextualIdentities.get(backgroundLogic.cookieStoreId(userContextId));\n` +
      // neverAsk mirrors the user ticking "Remember my decision": without it MAC parks the
      // tab on its confirm interstitial and no container tab appears.
      `      await assignManager.storageArea.set(url, { userContextId, neverAsk: true });\n` +
      // The beacon stops a test navigating into the middle of this seeding. Both extensions
      // read the assignment per request, so a write landing mid-navigation is seen by one
      // and missed by the other: the tab lands in a throwaway (CC missed it) or uncontained
      // (MAC missed it, CC deferred). launch() awaits this before returning.
      `      if (await assignManager.storageArea.get(url)) {\n` +
      `        await fetch(${JSON.stringify(assign.beaconUrl)}).catch(() => {});\n` +
      `        return;\n` +
      `      }\n` +
      `    } catch (e) { /* MAC still initialising, or the container not provisioned — retry */ }\n` +
      `    await new Promise((r) => setTimeout(r, 100));\n` +
      `  }\n` +
      // No beacon here on purpose: launch() fails with its own timeout instead of handing
      // back a session whose assignment never landed.
      `  console.error("[cc-harness] could not seed the MAC assignment");\n` +
      `})();\n`,
  );
  entries[page] = new TextEncoder().encode(
    html.replace("</body>", `  <script type="text/javascript" src="cc-harness-assign.js"></script>\n  </body>`),
  );
}

// Only `cc` needs building; the others ship as source.
async function buildXpiFor(
  ext: "probe" | "cc" | "mac",
  opts: {
    graceMs?: number | undefined;
    redirectorDelayMs?: number | undefined;
    configYaml?: string | undefined;
    notifyEchoTo?: string | undefined;
    macAssign?: { url: string; userContextId: string; beaconUrl: string } | undefined;
  },
): Promise<{ xpiPath: string; cleanup: () => void }> {
  if (ext === "cc") await buildExtension(opts);
  if (ext === "mac") {
    const assign = opts.macAssign;
    return zipDir(EXT_DIRS.mac, (entries) => {
      ensureMacLocale(entries);
      if (assign) injectMacAssignment(entries, assign);
    });
  }
  return zipDir(EXT_DIRS[ext]);
}

export async function launch(opts: LaunchOptions = {}): Promise<Session> {
  const extensions = opts.extensions ?? ["probe"];
  // Claimed BEFORE anything can start a browser, so every exit path below — including a
  // session creation that throws before any driver handle exists — has a token to reap by.
  const profileDir = claimProfileDir();
  const server: TestServer = await startServer();

  const xpis: { xpiPath: string; cleanup: () => void }[] = [];
  for (const ext of extensions) {
    xpis.push(
      await buildXpiFor(ext, {
        graceMs: opts.ccGraceMs,
        redirectorDelayMs: opts.ccRedirectorDelayMs,
        configYaml: opts.configYaml,
        notifyEchoTo: PROBE_EXTENSION_ID,
        macAssign: opts.macAssign && {
          url: `http://${opts.macAssign.host}:${new URL(server.url).port}/`,
          userContextId: opts.macAssign.userContextId,
          beaconUrl: `${server.url.replace(/\/$/, "")}${BEACON_PATH}?name=${MAC_ASSIGNED_BEACON}`,
        },
      }),
    );
  }
  const cleanupXpis = () => xpis.forEach((x) => x.cleanup());
  // Every failure below unwinds through this, so no path drops a running browser.
  // Browser-first: the server and temp dirs are cheap to lose, a Firefox is not.
  const teardown = async () => {
    reapProfile(profileDir);
    await server.close().catch(() => {});
    cleanupXpis();
  };

  const options = new firefox.Options();
  if (opts.headless !== false) options.addArguments("-headless");
  // A profile the harness made, not the one geckodriver would mkdtemp: it stamps this
  // browser's argv with a path only the reaper knows.
  options.addArguments("-profile", profileDir);
  options.setPreference("privacy.userContext.enabled", true);
  options.setPreference("xpinstall.signatures.required", false);
  // Pin CC's moz-extension:// origin so ccExtensionUrl() addresses a real page.
  options.setPreference(
    "extensions.webextensions.uuids",
    JSON.stringify({ [CC_EXTENSION_ID]: CC_EXTENSION_UUID }),
  );
  if (opts.startupUrl) {
    options.setPreference("browser.startup.page", 1); // 1 = open the homepage
    options.setPreference("browser.startup.homepage", opts.startupUrl);
  }
  // Fake domains straight to loopback, no DNS. Skipped when localDomains is null (live-site
  // manual testing).
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
    // A build() that throws can still leave a Firefox running (the macOS re-exec flake)
    // with no driver to quit it, so the reap is this path's only cleanup.
    await teardown();
    throw err;
  }

  // A seeded assignment is a PRECONDITION, not a background chore: both extensions read it
  // per request, so a navigation started mid-seeding is read differently by each and the tab
  // lands in whichever container lost the race. Hold the session back until MAC's own storage
  // says the assignment is there.
  if (opts.macAssign) {
    try {
      await server.awaitBeacon(MAC_ASSIGNED_BEACON);
    } catch (err) {
      await quit(driver);
      await teardown();
      throw err;
    }
  }

  let closed = false;
  return {
    driver,
    serverUrl: server.url,
    profileDir,
    async close() {
      if (closed) return; // a test may close a session its afterAll also closes
      closed = true;
      // quit() first so the browser shuts down cleanly, then reap what it left: a quit that
      // throws or hangs must not strand a Firefox, so teardown runs either way.
      try {
        await quit(driver);
      } finally {
        await teardown();
      }
    },
  };
}

// `driver.quit()` talks to a browser that may be wedged (a cancelled navigation blocks every
// WebDriver call — CLAUDE.md on F9), and an afterAll hanging here dies on vitest's
// hookTimeout with the browser still up. Bound it, let the reaper finish, swallow the throw.
async function quit(driver: WebDriver): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      driver.quit().catch(() => {}),
      new Promise((resolve) => (timer = setTimeout(resolve, QUIT_TIMEOUT_MS))),
    ]);
  } finally {
    clearTimeout(timer); // an uncleared timer holds the event loop open for its full wait
  }
}

const QUIT_TIMEOUT_MS = 20_000;

// Poll the CURRENT window's title until the probe has written "CSID:<store>".
export async function readCookieStoreId(driver: WebDriver, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastTitle = "";
  while (Date.now() < deadline) {
    lastTitle = await driver.getTitle();
    const m = lastTitle.match(/^CSID:(.+)$/);
    if (m) return m[1]!;
    await driver.sleep(100);
  }
  throw new Error(`Timed out waiting for probe report; last title: ${JSON.stringify(lastTitle)}`);
}

export async function readContainerName(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-container') || '';"
  )) as string;
}

// A SNAPSHOT, written when the document loaded — see listContainers for the live answer.
export async function readContainerList(driver: WebDriver): Promise<string[]> {
  const raw = (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-containers') || '';"
  )) as string;
  return raw ? raw.split(",") : [];
}

// Block until the probe has reported on the document the driver is CURRENTLY on.
//
// The probe writes its attributes from an async `tabs.executeScript` issued after two awaited
// `cookies.getAll` round-trips, so they land AFTER `driver.get` resolves — while
// server-rendered markup (`data-seen-cookie`) is there as the document parses. Asserting on
// both in one breath is a race, and it reads as "the cookie is missing" rather than "nobody
// has answered yet".
//
// `awaitContainerTab` covers almost every case free, since the probe writes the title in the
// same injected script. This is for the case with no reopen to wait for: a same-site
// navigation CC leaves alone.
export async function awaitProbeReport(driver: WebDriver, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reported = await driver.executeScript(
      "return document.documentElement.hasAttribute('data-cc-cookies-here');"
    );
    if (reported === true) return;
    await driver.sleep(100);
  }
  throw new Error(`probe never reported on ${await driver.getCurrentUrl()}`);
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

// Cookie names visible in the DEFAULT store for the tab's URL: the F11 counter-check.
export async function readCookieNamesDefault(driver: WebDriver): Promise<string[]> {
  const raw = (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-cookies-default') || '';"
  )) as string;
  return raw ? raw.split(",") : [];
}

// The localStorage.cc_script value the page's first script saw: "1" iff CC's document_start
// script ran before the page's own (F12 timing proof).
export async function readScriptAtStart(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-script-at-start') || '';"
  )) as string;
}

// The POST body the server saw, empty for a GET. Proves an assertion arrived intact rather
// than being lost to a reopen's GET (F9).
export async function readSeenPost(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.body.getAttribute('data-seen-post') || '';"
  )) as string;
}

// Generic localStorage read in the current tab — containers partition localStorage, so this
// reads that tab's own partition.
export async function readLocalStorage(driver: WebDriver, key: string): Promise<string | null> {
  return (await driver.executeScript(
    `return localStorage.getItem(${JSON.stringify(key)});`
  )) as string | null;
}

export interface ProbeTab {
  id: number;
  url: string;
  cookieStoreId: string;
  index: number; // position in its window — what "opened beside it" is asserted against
  windowId: number; // which window — what "the popup survived" is asserted against
  // The tab this one was opened from, absent when there is none. Optional because Firefox
  // omits it, not because a test may ignore it: it is the lineage F14 reads, and only the
  // browser can say whether it survives a reopen.
  openerTabId?: number;
  container: string;
}

// Send a command to the probe extension and return its reply.
//
// The driver must be on a probe-reported http(s) page: the probe injects a `cc-probe-cmd` DOM
// listener there that relays to its background (which holds the privileged APIs) and writes
// the reply into data-cc-result. WebDriver has no extension APIs, so this is the only route
// to browser.*.
//
// The reply lives in the RELAYING document, so a command that tears that document down (a
// `nav` of this very tab) loses its own answer: the poll then reads a fresh document with no
// attribute and gives up as a timeout. `navigateTab` carries the guard.
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

// Live from browser.contextualIdentities.query. Watching a container be REMOVED through
// readContainerList's snapshot would mean navigating a tab on every poll; this asks the
// browser each time, from a tab the test never touches.
export function listContainers(driver: WebDriver): Promise<string[]> {
  return probeCommand(driver, "containers");
}

export interface ProbeNotification {
  title: string;
  message: string;
}

// Notifications CC's test build echoed to the probe. Polls, because the echo races the page
// load the driver is parked on; a desktop notification is in no DOM, so this relay is the
// only way L4 can observe one.
export async function readNotifications(
  driver: WebDriver,
  match: (n: ProbeNotification) => boolean,
  timeoutMs = 15_000,
): Promise<ProbeNotification> {
  const deadline = Date.now() + timeoutMs;
  let seen: ProbeNotification[] = [];
  while (Date.now() < deadline) {
    seen = await probeCommand<ProbeNotification[]>(driver, "notifications");
    const hit = seen.find(match);
    if (hit) return hit;
    await driver.sleep(300);
  }
  throw new Error(`no matching notification; saw ${JSON.stringify(seen)}`);
}

// A REAL new tab — `browser.tabs.create({})`, what Ctrl/Cmd+T does: about:newtab in the
// default container. WebDriver's switchTo().newWindow("tab") makes an about:blank tab, which
// auto-temp ignores by design, and WebDriver cannot navigate to about:newtab either.
export function openRealNewTab(driver: WebDriver): Promise<{ id: number; url: string; cookieStoreId: string }> {
  return probeCommand(driver, "newTab");
}

// Every tab's id/url/cookieStoreId/container name, from browser.tabs.query. Needed because
// about: pages take no content script, so the probe's usual reporting cannot see a new-tab
// page's container.
export function listTabs(driver: WebDriver): Promise<ProbeTab[]> {
  return probeCommand(driver, "tabs");
}

// Navigate a specific tab by its browser.tabs id — what typing a URL into its address bar
// does. WebDriver drives only the tab it is switched to and cannot map a window handle to a
// tab id, so an about:newtab tab is otherwise unaddressable.
//
// The tab navigated must NOT be the one the driver is parked on: the reply is written into
// the relaying document (see probeCommand) and this navigation destroys it. The probe refuses
// that rather than letting it race — park on another probe-reported page first.
export async function navigateTab(driver: WebDriver, tabId: number, url: string): Promise<{ ok: boolean }> {
  const reply = await probeCommand<{ ok: boolean; error?: string }>(driver, "nav", { id: tabId, url });
  if (!reply.ok) throw new Error(`navigateTab(${tabId}, ${url}): ${reply.error}`);
  return reply;
}

// Open a URL in a NEW tab via the probe, leaving the driver where it is. That matters twice:
// a navigation CC cancels never returns to WebDriver, so `driver.get` from a committed page
// hangs until the test times out, and the driver's own tab is often the relay a test needs.
export function openTab(driver: WebDriver, url: string): Promise<{ id: number; url: string }> {
  return probeCommand(driver, "open", { url });
}

// What "View Page Source" does: open `view-source:<url>` in a new tab, in the container of
// the page it was invoked on. The keystroke is chrome-level and WebDriver refuses the scheme,
// so the probe is the only route — but the load itself is the browser's, which is the point.
export function openViewSource(
  driver: WebDriver,
  url: string,
  cookieStoreId: string,
): Promise<{ id: number; url: string; cookieStoreId: string }> {
  return probeCommand(driver, "viewSource", { url, cookieStoreId });
}

// Open a URL in a new tab via the probe. The only way a test reaches a moz-extension:// page:
// WebDriver refuses that scheme, while an extension may open another extension's pages. The
// driver must already be on a probe-reported http(s) page for the relay to exist.
//
// ONCE THERE, NOTHING MAY RUN A SCRIPT IN THAT PAGE. An extension page lives in the extension
// process, which Firefox counts as a PRIVILEGED browsing context, and Marionette refuses
// ExecuteScript and ExecuteAsyncScript in one unless the browser was started with
// `--remote-allow-system-access` (`isPrivilegedContext`, BrowsingContextUtils.sys.mjs;
// measured on 156.0a1, where it broke nine cases at once). That rules out `driver.executeScript`
// AND `WebElement.getAttribute`, which Selenium implements as an injected atom rather than a
// protocol command — the trap, because it is the same call every http(s) case makes.
//
// Everything an extension page needs is a real protocol command and keeps working:
// `getDomAttribute` (a data-* attribute), `getProperty` (a textarea's value), `getText`,
// `isEnabled`, `click`, `clear`, `sendKeys` and `switchTo().activeElement()`. The harness's
// own read helpers below stay on executeScript on purpose: every one of them reads a
// probe-written attribute on an http(s) page, which is ordinary web content.
//
// The flag is not the fix. It re-grants privileged access to the whole session — including
// the chrome-scope reach these cases have no business having — to keep one convenience call
// working, and it would make the suite depend on a Firefox that permits what a shipped
// extension's users never will.
export function openExtensionPage(
  driver: WebDriver,
  url: string,
): Promise<{ id: number; url: string }> {
  return openTab(driver, url);
}

// Switch the driver to the first window handle whose URL starts with `urlPrefix`. Opening a
// tab does not move the driver, and an extension page is not addressable by navigation, so
// this is how a test starts operating one.
export async function switchToUrl(
  driver: WebDriver,
  urlPrefix: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    seen = [];
    for (const handle of await driver.getAllWindowHandles()) {
      try {
        await driver.switchTo().window(handle);
        const current = await driver.getCurrentUrl();
        seen.push(current);
        if (current.startsWith(urlPrefix)) return;
      } catch {
        // Tab vanished mid-poll (CC reopens tear tabs down) — keep looking.
      }
    }
    await driver.sleep(200);
  }
  throw new Error(`no window at ${urlPrefix}; saw ${JSON.stringify(seen)}`);
}

// Poll window handles, without re-navigating them (CC does the reopening), until a tab shows
// `url` in a non-default container; return its store and reported name.
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
        if (m && /^firefox-container-\d+$/.test(m[1]!) && (await driver.getCurrentUrl()).startsWith(url)) {
          return { store: m[1]!, name: await readContainerName(driver) };
        }
      } catch {
        // A handle may have closed mid-loop; skip it this round.
      }
    }
    await driver.sleep(300);
  }
  throw new Error(`no container tab for ${url} within ${timeoutMs}ms`);
}

// Navigate every window handle to `url`, triggering a probe report on each, and collect
// their cookieStoreIds. Retries until a container store appears or the deadline passes, so
// the probe's own container tab may arrive late.
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
