import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, navigateToContainerTab, openExtensionPage, ccExtensionUrl, type Session } from "../../harness/firefox";
import type { Page } from "../../harness/browser/index";
import "../../harness/browser/matchers";

const OPTIONS_URL = ccExtensionUrl("options.html");

// harness/browser is built on the claim that these are W3C endpoints rather than scripts
// Selenium injects, so they answer on an extension page where `getAttribute` and
// `executeScript` are refused. Firefox 156 widened that refusal once already
// (isPrivilegedContext, nine cases at once), so this is the tripwire for the next time.
describe("what a privileged page answers (real Firefox)", () => {
  let firefox: Session;
  let options: Page;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    // The probe's command relay is a DOM event injected into http(s) pages only, so the
    // driver has to be parked on one before anything can ask it to open a page.
    const port = new URL(firefox.serverUrl).port;
    const relay = await navigateToContainerTab(
      firefox.browser,
      `http://work.example:${port}/?cb=privileged-${Date.now()}`,
    );
    await openExtensionPage(relay.page, OPTIONS_URL);
    options = await firefox.browser.pageAt(OPTIONS_URL);
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("answers the commands the locator layer is built on", async () => {
    // Through the locator layer, which is what actually depends on these commands: it
    // waits for the element to exist (the page is reachable a beat before its document
    // is), then answers each question with a protocol call rather than a script.
    const save = options.locator("#cc-save");
    await save.waitFor({ state: "visible" }); // Get Element Rect + Get Element CSS Value
    expect(await save.isEnabled()).toBe(true); // Is Element Enabled
    expect(await save.getAttribute("id")).toBe("cc-save"); // Get Element Attribute
    expect(await save.textContent()).toContain("Save"); // Get Element Property
    expect(await save.innerText()).toContain("Save"); // Get Element Text
    // A textarea's value — through the matcher, because this is the one read here that
    // races the PAGE rather than the protocol: the editor fills #cc-config from
    // storage.local after it renders, measured empty on one first read in twelve on
    // 140 ESR. `toHaveValue` polls Get Element Property, which is the command this case
    // exists to exercise either way.
    await expect(options.locator("#cc-config")).not.toHaveValue("");
  });

  // Deliberately NOT asserted here: that an injected script is refused. Measured on
  // 154.0, `executeScript("return 1;")` on this very page answers 1 — the refusal is
  // 156.0a1's widened `isPrivilegedContext` check and has not reached release. Pinning it
  // would fail on every channel CI runs while nothing was wrong, and pinning the opposite
  // would go green today and red the day the widening ships. The harness keeps avoiding
  // injected scripts either way, because Nightly is where release is going.
});
