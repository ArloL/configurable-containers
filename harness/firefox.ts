import { firefox, type BrowserContext, type Page } from "playwright";
import { withExtension } from "playwright-webextext";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startServer, type TestServer } from "./server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = path.resolve(HERE, "../extensions/probe");

export interface Session {
  context: BrowserContext;
  serverUrl: string;
  close(): Promise<void>;
}

export async function launch(): Promise<Session> {
  const server: TestServer = await startServer();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "cc-e2e-"));

  let context: BrowserContext;
  try {
    const browserType = withExtension(firefox, PROBE_PATH);
    context = await browserType.launchPersistentContext(userDataDir, {
      headless: true,
      // The contextualIdentities API is only available when the containers
      // feature is enabled; enable it explicitly so the probe can create one.
      firefoxUserPrefs: { "privacy.userContext.enabled": true },
    });
  } catch (err) {
    // Launch failed after the server + temp profile were created — release them
    // so repeated failed runs don't leak ports or orphan temp dirs.
    await server.close();
    rmSync(userDataDir, { recursive: true, force: true });
    throw err;
  }

  return {
    context,
    serverUrl: server.url,
    async close() {
      await context.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

// Poll a tab's title until the probe has written "CSID:<cookieStoreId>".
export async function readCookieStoreId(page: Page, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastTitle = "";
  while (Date.now() < deadline) {
    lastTitle = await page.title();
    const m = lastTitle.match(/^CSID:(.+)$/);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for probe report; last title: ${JSON.stringify(lastTitle)}`);
}

// Navigate every open tab to `url` (triggering a probe report on each) and
// collect their cookieStoreIds. Retries until a container store appears or the
// deadline passes, tolerating the probe's container tab arriving asynchronously.
export async function collectStoresUntilContainer(
  context: BrowserContext,
  url: string,
  timeoutMs = 15_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let stores: string[] = [];
  while (Date.now() < deadline) {
    stores = [];
    for (const page of context.pages()) {
      try {
        await page.goto(url, { waitUntil: "load" });
        stores.push(await readCookieStoreId(page, 2000));
      } catch {
        // A tab may have closed/navigated mid-loop; skip it this round.
      }
    }
    if (stores.some((s) => /^firefox-container-\d+$/.test(s))) return stores;
    await new Promise((r) => setTimeout(r, 500));
  }
  return stores;
}
