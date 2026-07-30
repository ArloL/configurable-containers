import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import {
  launch, awaitContainerTab, openExtensionPage, switchToUrl, ccExtensionUrl,
  type Session,
} from "../../harness/firefox";

const OPTIONS_URL = ccExtensionUrl("options.html");

// Both cases keep work.example routed to Work, so parking the driver on a probe-reported
// page behaves exactly as it does in test/e2e/options.test.ts — matched, so CC leaves the
// tab alone after the first visit rather than churning it.
const SMALL_CONFIG = `
rules:
  - match: work.example
    open: Work
`;

// Comfortably past CHUNK_CHARS (3000), so it cannot fit in one storage.sync item. Firefox
// enforces QUOTA_BYTES_PER_ITEM = 8192 over the JSON encoding of the value, and this is
// the only place in the suite where that enforcement is real rather than modelled — every
// L1 case interpolates CHUNK_CHARS and would stay green with chunking removed.
const MANY_PART_CONFIG =
  SMALL_CONFIG +
  Array.from({ length: 100 }, (_, i) => `# padding ${i} ${"filler-".repeat(8)}`).join("\n") +
  "\n";

// The background is the only writer of the sync area and it publishes in its startup
// tail, so a config reaches storage.sync without anyone saving anything. That is what
// makes these two cases cheap: park once, open the editor once, read what it found.
// Driving a Save instead would mean re-parking after runtime.reload(), on a window handle
// that is by then a torn-down extension page — which hangs the driver rather than failing.
// The save-to-publish handoff is covered at test/extension/config-sync.test.ts.
function syncCase(name: string, configYaml: string, want: RegExp, check: (status: string) => void) {
  describe(name, () => {
    let firefox: Session;
    let serverPort: string;

    beforeAll(async () => {
      firefox = await launch({ extensions: ["probe", "cc"], configYaml });
      serverPort = new URL(firefox.serverUrl).port;
    });

    afterAll(async () => {
      await firefox?.close();
    });

    it("reports the config as published to Firefox Sync", async () => {
      // Park on a probe-reported page so the cc-probe-cmd relay exists; the cache-buster
      // forces a fresh probe report.
      const url = `http://work.example:${serverPort}/?cb=sync-${Date.now()}`;
      try {
        await firefox.driver.get(url);
      } catch {
        // First visit reopens the tab into Work, tearing this one down — expected.
      }
      await awaitContainerTab(firefox.driver, url);

      await openExtensionPage(firefox.driver, OPTIONS_URL);
      await switchToUrl(firefox.driver, OPTIONS_URL);

      check(await awaitSyncStatus(firefox.driver, want));
    });
  });
}

// The status line is rendered from a live read of storage.sync on load and re-rendered on
// change, so polling it is how a test observes what Firefox actually accepted.
async function awaitSyncStatus(driver: WebDriver, want: RegExp, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen = await driver.findElement(By.id("cc-sync")).getText();
    if (want.test(seen)) return seen;
    await driver.sleep(300);
  }
  throw new Error(`sync status never matched ${want}; last saw ${JSON.stringify(seen)}`);
}

describe("config sync (real Firefox, CC + probe)", () => {
  syncCase("a config that fits in one sync item", SMALL_CONFIG, /Synced via Firefox Sync/, (status) => {
    // Proves the whole chain against Firefox rather than a mock of it: the background
    // encoded the config, browser.storage.sync accepted the write, and it reads back
    // byte-identical to what is in storage.local.
    expect(status).toMatch(/1 part\b/);
  });

  syncCase("a config too large for one sync item", MANY_PART_CONFIG, /Synced via Firefox Sync/, (status) => {
    const parts = Number(/(\d+) parts?\b/.exec(status)![1]);
    // A single-item implementation is rejected by Firefox's per-item quota and fails
    // here and nowhere else in the suite.
    expect(parts).toBeGreaterThan(1);
  });
});
