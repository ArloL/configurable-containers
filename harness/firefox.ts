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

// The beacon the seeded MAC assignment reports itself through (harness/server.ts).
// A background page's storage is in no DOM, so a fetch to the test server is the only
// way Node learns the seeding finished — and launch() must know before it hands the
// session to a test that will navigate.
const MAC_ASSIGNED_BEACON = "mac-assigned";

// CC's extension id (must match extensions/cc/manifest.json) and a FIXED uuid for
// its moz-extension:// origin, pinned via the extensions.webextensions.uuids pref in
// launch(). Without the pin the origin is random per profile and a test could not
// address an extension page at all.
export const CC_EXTENSION_ID = "configurable-containers@k5d.de";
export const CC_EXTENSION_UUID = "5c5b6d4e-9f3a-4a21-8b7c-1d2e3f4a5b6c";

// The probe's own id, from extensions/probe/manifest.json. CC's e2e build echoes its
// notifications here; buildExtension defaults this off for every shipped build.
export const PROBE_EXTENSION_ID = "probe@configurable-containers.test";

export function ccExtensionUrl(pagePath: string): string {
  return `moz-extension://${CC_EXTENSION_UUID}/${pagePath}`;
}

// Default fake domains resolved to loopback for e2e tests.
const DEFAULT_LOCAL_DOMAINS = [
  "work.example", "nomatch.example", "redirect.example", "figma.example", "youtube.example",
  "hop.example",
];

export interface Session {
  driver: WebDriver;
  serverUrl: string;
  // The profile directory this browser was launched into — the token the reaper
  // identifies its processes by (harness/reaper.ts). Exposed so a test can assert
  // nothing is left running under it.
  profileDir: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  extensions?: ("probe" | "cc" | "mac")[];
  // Seed a MAC site assignment (requires the "mac" extension). Given as a HOST, not a
  // url, because the test server's port is only known inside launch() and MAC keys
  // assignments by hostname+port. userContextId is the number in a cookieStoreId:
  // "1" is firefox-container-1, Firefox's built-in Personal.
  macAssign?: { host: string; userContextId: string };
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
// installAddon wants a file, not a directory). Uses fflate for the same reason
// scripts/package.ts does — no dependency on a `zip` binary being installed.
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

// MAC's manifest declares `default_locale: "en"`, but mac/src/_locales is a NESTED
// submodule (mozilla-l10n/multi-account-containers-l10n) we deliberately do not check
// out — Firefox then rejects the add-on outright ("Extension is invalid"). Every string
// it supplies is display text; the background logic under test uses none of it. So the
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

// Seed a MAC site assignment by appending one script to MAC's background PAGE inside
// the .xpi we build. The checkout on disk is never touched — the rewrite happens on
// the in-memory zip entries, the same spirit as CC's build-time config injection.
//
// This substitutes for the ONE step of a real MAC setup that cannot be scripted: an
// assignment is created from MAC's browser-action popup (or context menu), both
// chrome UI Selenium cannot drive, and MAC's external API exposes only `getAssignment`,
// no setter. Everything actually under test stays stock MAC: the seeding calls MAC's
// OWN `storageArea.set`, so the storage-key format lives in MAC's code and is never
// mirrored here, and CC still reads it back through MAC's real `getAssignment` path.
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
      // The container MUST resolve before the assignment is written. MAC deletes any
      // assignment whose container it cannot get and lets the page load uncontained
      // (assignManager.js, "The container we have in the assignment map isn't present
      // any more"). CC has deferred to MAC by then, so nothing routes the tab AND the
      // assignment is gone for good — the test fails as "no container tab" for its whole
      // timeout, never as a wrong one. Firefox provisions even the built-in containers
      // lazily, so on a cold profile this get is exactly what loses the race.
      `      await browser.contextualIdentities.get(backgroundLogic.cookieStoreId(userContextId));\n` +
      // neverAsk mirrors the user ticking "Remember my decision": without it MAC parks
      // the tab on its confirm-page interstitial instead of reopening, and no container
      // tab ever appears (assignManager.js reloadPageInContainer).
      `      await assignManager.storageArea.set(url, { userContextId, neverAsk: true });\n` +
      // The beacon is what stops a test navigating into the middle of this seeding.
      // Until the assignment is readable, MAC has nothing to route on and CC has
      // nothing to defer to, and BOTH answers are read per-request: a write landing
      // mid-navigation is read by one extension and missed by the other, so the tab
      // ends up in a throwaway (CC missed it) or uncontained (MAC missed it, CC
      // deferred). launch() awaits this before returning, so neither can happen.
      `      if (await assignManager.storageArea.get(url)) {\n` +
      `        await fetch(${JSON.stringify(assign.beaconUrl)}).catch(() => {});\n` +
      `        return;\n` +
      `      }\n` +
      `    } catch (e) { /* MAC still initialising, or the container not provisioned — retry */ }\n` +
      `    await new Promise((r) => setTimeout(r, 100));\n` +
      `  }\n` +
      // No beacon is sent on this path on purpose: launch() then fails with its own
      // timeout instead of handing back a session whose assignment never landed.
      `  console.error("[cc-harness] could not seed the MAC assignment");\n` +
      `})();\n`,
  );
  entries[page] = new TextEncoder().encode(
    html.replace("</body>", `  <script type="text/javascript" src="cc-harness-assign.js"></script>\n  </body>`),
  );
}

// Build (cc only) then zip the given extension into an installable .xpi.
async function buildXpiFor(
  ext: "probe" | "cc" | "mac",
  opts: {
    graceMs?: number;
    redirectorDelayMs?: number;
    configYaml?: string;
    notifyEchoTo?: string;
    macAssign?: { url: string; userContextId: string; beaconUrl: string };
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
  // Claimed BEFORE anything can start a browser, so every exit path below — including
  // the one where session creation throws and no driver handle ever exists — has a
  // token to reap by.
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
  // Every failure below unwinds through this, so no path can drop a running browser.
  // Ordered browser-first: the server and the temp dirs are cheap to lose, a Firefox
  // is not.
  const teardown = async () => {
    reapProfile(profileDir);
    await server.close().catch(() => {});
    cleanupXpis();
  };

  const options = new firefox.Options();
  if (opts.headless !== false) options.addArguments("-headless");
  // Launch into a profile the harness made, rather than the one geckodriver would
  // mkdtemp for us: it stamps this browser's argv with a path only the reaper knows.
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
    // A build() that throws can still have left a Firefox running (the macOS re-exec
    // flake), and there is no driver to quit it with — the reap is the only cleanup
    // this path has.
    await teardown();
    throw err;
  }

  // A seeded assignment is a PRECONDITION of the session, not a background chore: MAC
  // reads it per request and CC asks MAC per request, so a navigation started while the
  // seeding is still running is read differently by the two extensions and lands the
  // tab in whichever container lost the race. Hold the session back until MAC's own
  // storage says the assignment is there.
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
      // quit() first so the browser gets to shut down cleanly, then reap what it left
      // — a quit that throws or hangs must not be able to strand a Firefox, which is
      // why teardown runs either way rather than after a successful quit.
      try {
        await quit(driver);
      } finally {
        await teardown();
      }
    },
  };
}

// `driver.quit()` talks to a browser that may be wedged (a cancelled navigation leaves
// WebDriver calls blocking — see CLAUDE.md on F9), and an afterAll that hangs here dies
// on vitest's hookTimeout with the browser still up. Bound it and let the reaper finish
// the job; the throw is swallowed for the same reason.
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

// Block until the probe has reported on the document the driver is CURRENTLY on.
//
// Every read below is of an attribute the probe writes from an async
// `tabs.executeScript`, issued only after two awaited `cookies.getAll` round-trips — so
// the attributes land some time AFTER `driver.get` resolves, while server-rendered
// markup (`data-seen-cookie`) is there the instant the document parses. Reading the two
// in the same breath is therefore a race, and it reads as "the cookie is missing" rather
// than as "nobody has answered yet".
//
// Almost every case in the suite is already covered, because `awaitContainerTab` polls
// `document.title` and the probe writes the title in the SAME injected script as the
// attributes. This is for the case that has no reopen to wait for: a same-site
// navigation CC deliberately leaves alone.
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

// The POST body the server saw on this page's own request — empty for a GET. Proves an
// assertion arrived intact rather than being lost to a reopen's GET (F9).
export async function readSeenPost(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.body.getAttribute('data-seen-post') || '';"
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
  index: number; // position in its window — what "opened beside it" is asserted against
  windowId: number; // which window — what "the popup survived" is asserted against
  container: string;
}

// Send a command to the probe extension and return its reply.
//
// The driver must currently be on a probe-reported http(s) page: the probe injects a
// `cc-probe-cmd` DOM listener there that relays to its background (which holds the
// privileged APIs) and writes the reply back into data-cc-result. This is the only way
// a test can reach browser.* — WebDriver has no extension APIs.
//
// The reply therefore lives in the RELAYING document, and a command that tears that
// document down (a `nav` of this very tab) loses its own answer: the poll below then
// reads a fresh document with no attribute and gives up as a timeout. `navigateTab`
// carries the guard.
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

// Every container's name, live from browser.contextualIdentities.query. readContainerList
// reads a snapshot the probe wrote when a document loaded, so watching a container be
// REMOVED through it means navigating a tab on every poll; this asks the browser each
// time, from a tab the test never has to touch.
export function listContainers(driver: WebDriver): Promise<string[]> {
  return probeCommand(driver, "containers");
}

export interface ProbeNotification {
  title: string;
  message: string;
}

// Notifications CC's test build echoed to the probe. Polls, because the echo races the
// page load the driver is parked on; a desktop notification is in no DOM, so this
// relay is the only way L4 can observe one at all.
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
//
// The tab being navigated must NOT be the tab the driver is parked on: the reply is
// written into the relaying document (see probeCommand), and this navigation destroys
// it. The probe refuses that case rather than letting it race, and the refusal is
// raised here — park on another probe-reported page first.
export async function navigateTab(driver: WebDriver, tabId: number, url: string): Promise<{ ok: boolean }> {
  const reply = await probeCommand<{ ok: boolean; error?: string }>(driver, "nav", { id: tabId, url });
  if (!reply.ok) throw new Error(`navigateTab(${tabId}, ${url}): ${reply.error}`);
  return reply;
}

// Open a URL in a NEW tab via the probe, leaving the tab the driver is parked on where
// it is. That is the difference from `driver.get`, and it matters twice over: a
// navigation CC cancels never returns to WebDriver, so `driver.get` from a tab already
// on a committed page hangs until the test times out; and the driver's own tab is often
// the relay a test still needs.
export function openTab(driver: WebDriver, url: string): Promise<{ id: number; url: string }> {
  return probeCommand(driver, "open", { url });
}

// What "View Page Source" does: open `view-source:<url>` in a new tab, in the container
// the page it was invoked on is in. The keystroke is chrome-level and WebDriver refuses
// the scheme, so the probe is the only route to it — but the load itself is the browser's
// own, which is what the assertion is about.
export function openViewSource(
  driver: WebDriver,
  url: string,
  cookieStoreId: string,
): Promise<{ id: number; url: string; cookieStoreId: string }> {
  return probeCommand(driver, "viewSource", { url, cookieStoreId });
}

// Open a URL in a new tab via the probe. The ONLY way a test can reach a
// moz-extension:// page: WebDriver refuses that scheme ("Navigation to
// moz-extension://… is not allowed in this context"), while an extension may open
// another extension's pages. The driver must already be on a probe-reported http(s)
// page for the command relay to exist.
export function openExtensionPage(
  driver: WebDriver,
  url: string,
): Promise<{ id: number; url: string }> {
  return openTab(driver, url);
}

// Switch the driver to the first window handle whose URL starts with `urlPrefix`.
// Opening a tab does not move the driver, and an extension page is not addressable
// by navigation, so this is how a test starts operating one.
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
