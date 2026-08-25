import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import {
  launch,
  awaitContainerTab,
  awaitProbeReport,
  openExtensionPage,
  openTab,
  switchToUrl,
  ccExtensionUrl,
  listTabs,
  navigateTab,
  readContainerName,
  type Session,
} from "../../harness/firefox";

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
    try {
      await firefox.driver.get(first);
    } catch {
      // The navigation is cancelled and reopened in the throwaway, tearing this tab
      // down — expected, and why routing is always driven from a fresh tab.
    }
    const { name: container } = await awaitContainerTab(firefox.driver, first);
    expect(container).toMatch(/^tmp/);

    // The probe's command relay is a DOM event injected into http(s) pages only, so the
    // tab id has to be read while parked HERE — from the options page (moz-extension://)
    // no probe command can be answered at all.
    const target = (await listTabs(firefox.driver)).find((t) => t.url.startsWith(first.split("?")[0]!))!;
    expect(target).toBeDefined();

    // 2. Move to a relay page of its own before doing anything else. Every probe reply is
    //    written into the DOM of the page that dispatched the command, so relaying the
    //    cross-site `nav` below from the tab being navigated would destroy the answer with
    //    the document — an intermittent `probe command "nav" timed out`, which is exactly
    //    how this case flaked. work.example is a MATCHED host, so CC parks it in Work once
    //    and never touches it again. It is opened through the probe rather than with
    //    driver.get, which from this committed page would be cancelled by the reopen and
    //    never return.
    const relay = `http://work.example:${serverPort}/?cb=pause-relay-${Date.now()}`;
    await openTab(firefox.driver, relay);
    await awaitContainerTab(firefox.driver, relay);

    // 3. Arm that container from the options page.
    await openExtensionPage(firefox.driver, OPTIONS_URL);
    await switchToUrl(firefox.driver, OPTIONS_URL);
    const armButton = By.css(`button[data-cc-arm="${container}"]`);
    await firefox.driver.wait(async () => (await firefox.driver.findElements(armButton)).length > 0, 10_000);
    await firefox.driver.findElement(armButton).click();
    // getDomAttribute: Selenium implements getAttribute as an injected script, which an
    // extension page will not run (harness/firefox.ts, on operating an extension page).
    await firefox.driver.wait(
      async () => (await firefox.driver.findElement(armButton).getDomAttribute("data-cc-armed")) === "true",
      10_000,
    );

    // 4. Back to the relay page so the command relay works again, then navigate the ARMED
    //    tab CROSS-SITE — a hop that would normally buy a fresh throwaway, since
    //    nomatch.example and hop.example are different registrable domains.
    await switchToUrl(firefox.driver, relay);
    const second = `http://hop.example:${serverPort}/?cb=pause2-${Date.now()}`;
    await navigateTab(firefox.driver, target.id, second);

    // 5. The pause held. There is no reopen to wait for here — that is the point — so
    //    the probe's own report is the only signal the navigation finished.
    await switchToUrl(firefox.driver, second);
    await awaitProbeReport(firefox.driver);
    expect(await readContainerName(firefox.driver)).toBe(container);

    // 6. And the record names the host with the action CC declined to take. Live via
    //    storage.onChanged — no reload.
    await switchToUrl(firefox.driver, OPTIONS_URL);
    await firefox.driver.wait(async () => {
      const text = await firefox.driver.findElement(By.id("cc-pause-recordings")).getText();
      return text.includes("hop.example") && text.includes("temporary");
    }, 15_000);
  }, 120_000);
});
