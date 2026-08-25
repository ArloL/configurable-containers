import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch,
  awaitContainerTab,
  navigateToContainerTab,
  awaitProbeReport,
  openExtensionPage,
  openTab,
  ccExtensionUrl,
  listTabs,
  navigateTab,
  readContainerName,
  type Session,
} from "../../harness/firefox";
import "../../harness/browser/matchers";

const OPTIONS_URL = ccExtensionUrl("options.html");

// Arming is driven from the OPTIONS PAGE, not the toolbar button: WebDriver cannot click
// a browser_action at all. Both routes call the same arm() in src/engine/pause.ts, so
// what this covers is the whole arm -> record -> review loop; only the chrome-level click
// itself is out of reach.
describe("pause & record (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  }, 120_000);

  afterAll(async () => {
    await firefox?.close();
  });

  it("holds an armed container across a cross-site navigation and records what it declined", async () => {
    // 1. An unmatched host: CC routes it into a throwaway of its own.
    const first = `http://nomatch.example:${serverPort}/?cb=pause-${Date.now()}`;
    const armed = await navigateToContainerTab(firefox.browser, first);
    expect(armed.name).toMatch(/^tmp/);
    const container = armed.name;

    // The probe's command relay is a DOM event injected into http(s) pages only, so the
    // tab id is asked of an http page — from the options page (moz-extension://) no probe
    // command can be answered at all.
    const target = (await listTabs(armed.page)).find((t) => t.url.startsWith(first.split("?")[0]!))!;
    expect(target).toBeDefined();

    // 2. Move to a relay page of its own before doing anything else. Every probe reply is
    //    written into the DOM of the page that dispatched the command, so relaying the
    //    cross-site `nav` below from the tab being navigated would destroy the answer with
    //    the document — an intermittent `probe command "nav" timed out`, which is exactly
    //    how this case flaked. work.example is a MATCHED host, so CC parks it in Work once
    //    and never touches it again. It is opened through the probe rather than with
    //    driver.get, which from this committed page would be cancelled by the reopen and
    //    never return.
    const relayUrl = `http://work.example:${serverPort}/?cb=pause-relay-${Date.now()}`;
    await openTab(armed.page, relayUrl);
    const relay = (await awaitContainerTab(firefox.browser, relayUrl)).page;

    // 3. Arm that container from the options page.
    await openExtensionPage(relay, OPTIONS_URL);
    const options = await firefox.browser.pageAt(OPTIONS_URL);
    const armButton = options.locator(`button[data-cc-arm="${container}"]`);
    await armButton.click();
    await expect(armButton).toHaveAttribute("data-cc-armed", "true");

    // 4. Navigate the ARMED tab CROSS-SITE — a hop that would normally buy a fresh
    //    throwaway, since nomatch.example and hop.example are different registrable
    //    domains. Relayed through the work.example page, which nothing here navigates.
    const second = `http://hop.example:${serverPort}/?cb=pause2-${Date.now()}`;
    await navigateTab(relay, target.id, second);

    // 5. The pause held. There is no reopen to wait for here — that is the point — so
    //    the probe's own report is the only signal the navigation finished.
    const landed = await firefox.browser.pageAt(second);
    await awaitProbeReport(landed);
    expect(await readContainerName(landed)).toBe(container);

    // 6. And the record names the host with the action CC declined to take. Live via
    //    storage.onChanged — no reload.
    const recordings = options.locator("#cc-pause-recordings");
    await expect(recordings).toContainText("hop.example", { timeout: 15_000 });
    await expect(recordings).toContainText("temporary");
  }, 120_000);
});
