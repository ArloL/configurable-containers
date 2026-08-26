import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, navigateToContainerTab, openExtensionPage, ccExtensionUrl, type Session,
} from "../../harness/firefox";
import "../../harness/browser/matchers";

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
function syncCase(
  name: string,
  behaviour: string,
  configYaml: string,
  want: RegExp,
  check: (status: string) => void,
) {
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

    it(behaviour, async () => {
      // Park on a probe-reported page so the cc-probe-cmd relay exists; the cache-buster
      // forces a fresh probe report.
      const relay = await navigateToContainerTab(
        firefox.browser,
        `http://work.example:${serverPort}/?cb=sync-${Date.now()}`,
      );

      await openExtensionPage(relay.page, OPTIONS_URL);
      const options = await firefox.browser.pageAt(OPTIONS_URL);

      // The status is rendered from a live read of storage.sync, so the ASSERTION is what
      // waits: no element to find first, no poll loop, and a failure that reports the last
      // text it saw rather than a selector it could not locate.
      const status = options.locator("#cc-sync");
      await expect(status).toHaveText(want);
      // The SAME reading the assertion settled on, near enough: this element is rendered
      // from a live read of storage.sync, so a second innerText() is a second question
      // about a moving target rather than a closer look at the answer.
      const settled = await status.innerText();
      expect(settled, "the status changed under the second read").toMatch(want);
      check(settled);
    });
  });
}

describe("config sync (real Firefox, CC + probe)", () => {
  syncCase(
    "a config that fits in one sync item",
    "publishes it to Firefox Sync as a single part",
    SMALL_CONFIG,
    /Synced via Firefox Sync/,
    (status) => {
      // Proves the whole chain against Firefox rather than a mock of it: the background
      // encoded the config, browser.storage.sync accepted the write, and it reads back
      // byte-identical to what is in storage.local.
      expect(status).toMatch(/1 part\b/);
    },
  );

  syncCase(
    "a config too large for one sync item",
    "splits it across several parts rather than failing the quota",
    MANY_PART_CONFIG,
    /Synced via Firefox Sync/,
    (status) => {
      const parts = Number(/(\d+) parts?\b/.exec(status)![1]);
      // A single-item implementation is rejected by Firefox's per-item quota and fails
      // here and nowhere else in the suite.
      expect(parts).toBeGreaterThan(1);
    },
  );
});
