import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, navigateToContainerTab, openExtensionPage, ccExtensionUrl, type Session } from "../../harness/firefox";
import type { Page } from "../../harness/browser/index";
import "../../harness/browser/matchers";

const OPTIONS_URL = ccExtensionUrl("options.html");

// Every command harness/browser operates a page with, asked of an EXTENSION page — the kind
// Firefox counts as privileged. That scope answers nothing at all on 157 unless geckodriver
// was started with `--allow-system-access` (harness/firefox.ts argues the flag), so this
// case is what says the flag is still in effect and still enough. The refusal it exists for
// has widened twice — `executeScript` alone, then every browsing-context command, sixteen
// cases at once — and the Nightly leg was the notice both times.
describe("what a privileged page answers (real Firefox)", () => {
  let firefox: Session;
  let options: Page;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["cc"] });
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

  // Deliberately NOT asserted here: anything about an injected script. It ANSWERS on this
  // page on every channel now — measured 2026-09-10 on 140.15.0esr, 155.0.1 and 157.0a1 —
  // because system access lifts the refusal that made the avoidance automatic. So there is
  // nothing left for a case here to observe, and the rule moved to where it can still be
  // enforced: `test/fitness/e2e-discipline.test.ts`, "takes no privileged convenience the
  // browser used to refuse". Pinning the refusal here instead would pin the flag being OFF,
  // which is the state that takes the other sixteen cases down.
});
