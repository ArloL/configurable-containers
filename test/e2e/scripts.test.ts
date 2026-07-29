import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import {
  launch, awaitContainerTab, readScriptAtStart, readLocalStorage, readCookieNamesHere,
  openExtensionPage, switchToUrl, ccExtensionUrl, type Session,
} from "../../harness/firefox";

const OPTIONS_URL = ccExtensionUrl("options.html");

describe("scripts overlay (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
    await grantUserScriptsPermission();
  });

  // MV3: "userScripts" is optional-only, so a fresh profile does NOT have it and the
  // injector deliberately registers nothing. The options page carries the only grant
  // affordance there is (permissions.request needs a user gesture), so the overlay
  // cannot be exercised at all until something clicks it — which is what this does.
  // The grant reloads the extension, and the injector registers on that next startup.
  // Park on a probe-reported page so the cc-probe-cmd relay exists, then open the
  // editor on top of it.
  async function openEditor(tag: string) {
    const parkUrl = `http://work.example:${serverPort}/?cb=${tag}-${Date.now()}`;
    try {
      await firefox.driver.get(parkUrl);
    } catch {
      // First visit reopens the tab into Work, tearing this one down — expected.
    }
    await awaitContainerTab(firefox.driver, parkUrl);
    await openExtensionPage(firefox.driver, OPTIONS_URL);
    await switchToUrl(firefox.driver, OPTIONS_URL);
  }

  async function grantUserScriptsPermission() {
    await openEditor("grant");
    await firefox.driver.findElement(By.id("cc-grant")).click();

    // The click triggers runtime.reload() ~100ms later, which tears down every
    // extension page including the one the driver is parked on — every later call
    // would throw NoSuchWindowError against a discarded context.
    await new Promise((r) => setTimeout(r, 1000));
    const surviving = await firefox.driver.getAllWindowHandles();
    await firefox.driver.switchTo().window(surviving[0]);

    // Registration happens in background.ts's async tail on the NEXT startup, so it is
    // not done when the reload returns. Poll the real readiness signal rather than
    // sleeping a guessed interval: a fixed wait raced the reload and made this whole
    // case look like an MV3 injection failure when the injection was merely late.
    for (let attempt = 0; attempt < 10; attempt++) {
      await openEditor(`ready${attempt}`);
      const registered = (await firefox.driver.executeAsyncScript(`
        const cb = arguments[0];
        (async () => {
          try { cb((await browser.userScripts.getScripts()).length); }
          catch { cb(0); }
        })();
      `)) as number;
      if (registered > 0) {
        const handles = await firefox.driver.getAllWindowHandles();
        await firefox.driver.switchTo().window(handles[0]);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("userScripts were never registered after the permission grant");
  }

  afterAll(async () => {
    await firefox?.close();
  });

  async function navFreshTab(url: string) {
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("injects the script at document_start, before the page's own scripts, in the routed container", async () => {
    const url = `http://work.example:${serverPort}/`;
    await navFreshTab(url);

    // The routed Work tab (awaitContainerTab leaves the driver focused on it).
    const { name: containerName } = await awaitContainerTab(firefox.driver, url);
    expect(containerName).toBe("Work");

    // The cookie overlay (already shipped) still seeds alongside the new script overlay.
    expect(await readCookieNamesHere(firefox.driver)).toContain("seed");

    // F12 timing: the page's own first script saw cc_script ALREADY set — proving CC's
    // document_start content script ran before the page's <script>s.
    expect(await readScriptAtStart(firefox.driver)).toBe("1");

    // The script's effect is visible in localStorage (the Work container's partition).
    expect(await readLocalStorage(firefox.driver, "cc_script")).toBe("1");
  });
});
