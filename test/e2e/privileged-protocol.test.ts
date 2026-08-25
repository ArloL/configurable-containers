import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitContainerTab, awaitElement, openExtensionPage, switchToUrl, ccExtensionUrl,
  type Session,
} from "../../harness/firefox";

const OPTIONS_URL = ccExtensionUrl("options.html");

// harness/browser is built on the claim that these are W3C endpoints rather than scripts
// Selenium injects, so they answer on an extension page where `getAttribute` and
// `executeScript` are refused. Firefox 156 widened that refusal once already
// (isPrivilegedContext, nine cases at once), so this is the tripwire for the next time.
describe("what a privileged page answers (real Firefox)", () => {
  let firefox: Session;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    // The probe's command relay is a DOM event injected into http(s) pages only, so the
    // driver has to be parked on one before anything can ask it to open a page.
    const port = new URL(firefox.serverUrl).port;
    const url = `http://work.example:${port}/?cb=privileged-${Date.now()}`;
    try {
      await firefox.driver.get(url);
    } catch {
      // Reopened into Work, tearing this tab down — expected.
    }
    await awaitContainerTab(firefox.driver, url);
    await openExtensionPage(firefox.driver, OPTIONS_URL);
    await switchToUrl(firefox.driver, OPTIONS_URL);
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("answers the commands the locator layer is built on", async () => {
    // Waiting for the element to EXIST before reading it: the page is reachable a beat
    // before its document is, which is the whole reason harness/browser exists.
    const save = await awaitElement(firefox.driver, "cc-save");

    const rect = await save.getRect();
    expect(rect.width, "Get Element Rect must report a real box").toBeGreaterThan(0);
    expect(await save.getCssValue("visibility")).toBe("visible");
    expect(await save.isEnabled()).toBe(true);
    expect(await save.getDomAttribute("id")).toBe("cc-save");
    expect(await save.getProperty("tagName")).toBe("BUTTON");
    expect(await save.getText()).toContain("Save");
  });

  // Deliberately NOT asserted here: that an injected script is refused. Measured on
  // 154.0, `executeScript("return 1;")` on this very page answers 1 — the refusal is
  // 156.0a1's widened `isPrivilegedContext` check and has not reached release. Pinning it
  // would fail on every channel CI runs while nothing was wrong, and pinning the opposite
  // would go green today and red the day the widening ships. The harness keeps avoiding
  // injected scripts either way, because Nightly is where release is going.
});
