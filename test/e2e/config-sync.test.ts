import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import {
  launch, awaitContainerTab, openExtensionPage, switchToUrl, ccExtensionUrl,
  type Session,
} from "../../harness/firefox";

const OPTIONS_URL = ccExtensionUrl("options.html");

const ONE_PART_CONFIG = `
rules:
  - match: nomatch.example
    open: Editor
`;

// Comfortably past CHUNK_CHARS (3000), so it cannot fit in one storage.sync item.
// Firefox enforces QUOTA_BYTES_PER_ITEM = 8192 over the JSON encoding of the value, and
// this is the only place in the suite where that enforcement is real rather than modelled.
const MANY_PART_CONFIG =
  ONE_PART_CONFIG +
  Array.from({ length: 100 }, (_, i) => `# padding ${i} ${"filler-".repeat(8)}`).join("\n") +
  "\n";

describe("config sync (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  // Park on a probe-reported page so the cc-probe-cmd relay exists. work.example is
  // matched, so CC leaves it in Work rather than churning; the cache-buster forces a
  // fresh probe report.
  async function parkOnProbePage(tag: string) {
    const url = `http://work.example:${serverPort}/?cb=${tag}-${Date.now()}`;
    try {
      await firefox.driver.get(url);
    } catch {
      // First visit reopens the tab into Work, tearing this one down — expected.
    }
    await awaitContainerTab(firefox.driver, url);
  }

  async function openEditor(tag: string) {
    await parkOnProbePage(tag);
    await openExtensionPage(firefox.driver, OPTIONS_URL);
    await switchToUrl(firefox.driver, OPTIONS_URL);
  }

  // Set the textarea and fire `input` — assigning .value alone does not, so
  // validation would never run.
  async function typeConfig(text: string) {
    await firefox.driver.executeScript(
      "const t = document.getElementById('cc-config');" +
      `t.value = ${JSON.stringify(text)};` +
      "t.dispatchEvent(new Event('input'));"
    );
  }

  async function saveAndWaitForReload() {
    await firefox.driver.findElement(By.id("cc-save")).click();
    // runtime.reload() tears down every extension page, this tab included. Get off it
    // before touching the driver again.
    await firefox.driver.sleep(2000);
    const handles = await firefox.driver.getAllWindowHandles();
    await firefox.driver.switchTo().window(handles[0]);
  }

  // The status line is rendered from a live read of storage.sync, so polling it is how a
  // test observes what Firefox actually accepted. Every options tab is tried because a
  // reload leaves the previous one behind and only the fresh one answers.
  async function awaitSyncStatus(driver: WebDriver, want: RegExp, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let seen = "";
    while (Date.now() < deadline) {
      for (const handle of await driver.getAllWindowHandles()) {
        try {
          await driver.switchTo().window(handle);
          if (!(await driver.getCurrentUrl()).startsWith(OPTIONS_URL)) continue;
          const text = await driver.findElement(By.id("cc-sync")).getText();
          if (text !== "") seen = text;
          if (want.test(text)) return text;
        } catch {
          // A dead options tab from the reload before this one — keep looking.
        }
      }
      await driver.sleep(300);
    }
    throw new Error(`sync status never matched ${want}; last saw ${JSON.stringify(seen)}`);
  }

  it("publishes a saved config to Firefox Sync", async () => {
    await openEditor("sync-save");
    await typeConfig(ONE_PART_CONFIG);
    await saveAndWaitForReload();

    // The background publishes in its startup tail, after the reload — so the proof is
    // the freshly opened editor reading the record back out of storage.sync.
    await openEditor("sync-verify");
    const status = await awaitSyncStatus(firefox.driver, /Synced via Firefox Sync — 1 part,/);

    expect(status).toMatch(/last change/);
  });

  it("publishes a config too large for a single sync item", async () => {
    await openEditor("sync-large");
    await typeConfig(MANY_PART_CONFIG);
    await saveAndWaitForReload();

    await openEditor("sync-large-verify");
    const status = await awaitSyncStatus(firefox.driver, /Synced via Firefox Sync — \d+ parts,/);

    // A single-item implementation is rejected by Firefox's per-item quota and fails
    // here and nowhere else in the suite.
    const parts = Number(/— (\d+) parts/.exec(status)![1]);
    expect(parts).toBeGreaterThan(1);
  });
});
