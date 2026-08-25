import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import {
  launch, awaitContainerTab, openExtensionPage, switchToUrl, ccExtensionUrl, listTabs,
  readContainerName, type Session,
} from "../../harness/firefox";

const OPTIONS_URL = ccExtensionUrl("options.html");

// A config the editor types in: routes nomatch.example (which matches nothing in the
// bundled test config) into a permanent container named Editor.
const EDITED_CONFIG = `
rules:
  - match: nomatch.example
    open: Editor
`;

// Uses a match pattern, which is a version 2 feature — so saving it must write the marker
// that tells an older build the keys it does not recognise are features, not typos.
const PATTERN_CONFIG = `
rules:
  - match: "*://nomatch.example/*"
    open: Editor
`;

// What a machine still on this build sees of a config a newer one wrote.
const FUTURE_CONFIG = `
version: 99
rules:
  - match: nomatch.example
    open: Editor
    sandbox: true
`;

const BROKEN_SEED = `
rules:
  - match: 123
    open: Nope
`;

describe("options page (real Firefox, CC + probe)", () => {
  describe("with a valid seed", () => {
    let firefox: Session;
    let serverPort: string;

    beforeAll(async () => {
      firefox = await launch({ extensions: ["probe", "cc"] });
      serverPort = new URL(firefox.serverUrl).port;
    });

    afterAll(async () => {
      await firefox?.close();
    });

    // Park on a probe-reported page so the cc-probe-cmd relay exists; the cache-buster
    // forces a fresh probe report.
    //
    // From a FRESH tab every time, never the one the driver happens to be on. Once a case
    // has saved a config of its own, work.example may be unmatched — and a reopen CANCELS
    // the navigation of a tab that is already on a page, which never returns to WebDriver.
    // That reads as the case timing out with no assertion having run.
    async function parkOnProbePage(tag: string) {
      const url = `http://work.example:${serverPort}/?cb=${tag}-${Date.now()}`;
      await firefox.driver.switchTo().newWindow("tab");
      try {
        await firefox.driver.get(url);
      } catch {
        // Reopened into a container, tearing this tab down — expected.
      }
      await awaitContainerTab(firefox.driver, url);
    }

    // The page fills #cc-config from `storage.local` AFTER it renders, and switchToUrl
    // returns on the url alone — so the editor is reachable a beat before it is populated.
    // Measured on 140 ESR: one first read in twelve came back empty, hydrating 13ms later.
    // It is not a slow machine's problem either. `getAttribute` used to absorb the gap by
    // accident, being a script Selenium injects rather than a protocol command, and the
    // faster call that replaced it turned a standing race into a red main.
    //
    // So every case waits for the text before touching the editor, typeConfig included:
    // an async fill landing after clear() + sendKeys() would overwrite the config just
    // typed, and that failure would read as the editor ignoring input.
    async function openEditor(tag: string) {
      await parkOnProbePage(tag);
      await openExtensionPage(firefox.driver, OPTIONS_URL);
      await switchToUrl(firefox.driver, OPTIONS_URL);
      await firefox.driver.wait(
        async () => (await firefox.driver.findElement(By.id("cc-config")).getProperty("value")) !== "",
        10_000,
        "the options page never hydrated #cc-config from storage",
      );
    }

    // Clear and TYPE, rather than assigning .value and dispatching a synthetic `input`:
    // Selenium's executeScript is a script injected into the page, and Firefox refuses to
    // run one in an extension page (harness/firefox.ts, on operating an extension page).
    // Element Clear and Element Send Keys are protocol commands rather than injected
    // script, and they fire the real `input` the editor validates on — which assigning
    // .value alone never did either, hence the dispatch this replaces.
    async function typeConfig(text: string) {
      const field = firefox.driver.findElement(By.id("cc-config"));
      await field.clear();
      await field.sendKeys(text);
    }

    it("shows the seeded config on first run", async () => {
      await openEditor("seed");
      // getProperty, not getAttribute: a textarea's text is a property, and Selenium
      // implements getAttribute as an injected script this page will not run. Safe to read
      // once here — openEditor has already waited for the fill.
      const value = await firefox.driver.findElement(By.id("cc-config")).getProperty("value");
      // The bundled test config was written to storage at first run.
      expect(value).toContain("work.example");
      expect(value).toContain("redirect.example");
    });

    it("refuses to save a config that does not parse", async () => {
      await openEditor("invalid");
      await typeConfig("rules:\n  - match: 123\n    open: Nope\n");

      const error = await firefox.driver.findElement(By.id("cc-error")).getText();
      expect(error).not.toBe("");
      expect(await firefox.driver.findElement(By.id("cc-save")).isEnabled()).toBe(false);

      // …and recovers when the text becomes valid again.
      await typeConfig(EDITED_CONFIG);
      expect(await firefox.driver.findElement(By.id("cc-error")).getText()).toBe("");
      expect(await firefox.driver.findElement(By.id("cc-save")).isEnabled()).toBe(true);
    });

    it("routes by the saved config once the editor reports it applied", async () => {
      // This case ran nowhere below Firefox 154 until the save stopped reloading the
      // extension: `runtime.reload()` does not bring a TEMPORARILY installed one back on
      // 140.14.0esr, so the OLD background went on applying the OLD config while the editor
      // reported success. That was the only case the ESR leg could not observe, and the
      // whole reason a save now applies its config in place.

      await openEditor("save");
      await typeConfig(EDITED_CONFIG);
      await firefox.driver.findElement(By.id("cc-save")).click();

      // The status is written when the background answers, so this is a real
      // synchronisation point rather than a guess at how long a restart takes. It is also
      // the assertion the old path could not make: "Saved" used to be printed before
      // anything had been applied.
      await firefox.driver.wait(
        async () => (await firefox.driver.findElement(By.id("cc-status")).getText()) === "Saved",
        10_000,
        "the editor never reported the config applied",
      );

      // This page survives its own save now; get off it before driving navigations.
      const handles = await firefox.driver.getAllWindowHandles();
      await firefox.driver.switchTo().window(handles[0]!);

      // nomatch.example matched no rule before this edit; it must now land in Editor.
      //
      // Still polled: the status says the config is live, and what is asserted below is the
      // routing that follows from it, one navigation later.
      //
      // Each attempt is a FRESH tab: CC keeps a tab that is already on a page and only
      // cancels its navigation, and a cancelled navigation never returns to the driver.
      const deadline = Date.now() + 20_000;
      let container = "";
      while (Date.now() < deadline) {
        const url = `http://nomatch.example:${serverPort}/?cb=edited-${Date.now()}`;
        await firefox.driver.switchTo().newWindow("tab");
        try {
          await firefox.driver.get(url);
        } catch {
          // CC reopens the blank tab into Editor, tearing this one down — expected.
        }
        await awaitContainerTab(firefox.driver, url);
        container = await readContainerName(firefox.driver);
        if (container === "Editor") break;
        await firefox.driver.sleep(500);
      }
      expect(container, "the saved config never took effect").toBe("Editor");
    });

    it("stamps the version a saved config earns", async () => {
      await openEditor("stamp");
      await typeConfig(PATTERN_CONFIG);
      await firefox.driver.findElement(By.id("cc-save")).click();
      await firefox.driver.wait(
        async () => (await firefox.driver.findElement(By.id("cc-status")).getText()) === "Saved",
        10_000,
        "the editor never reported the config applied",
      );

      // Back in the editor, because the stored text and the text on screen must be the
      // same text — the line is derived, and a user who never learns the number still gets
      // the benefit of it on their other machines.
      const value = await firefox.driver.findElement(By.id("cc-config")).getProperty("value");
      expect(value).toContain("version: 2");
    });

    it("edits and saves a config written by a newer build without losing what it cannot read", async () => {
      await openEditor("future");
      await typeConfig(FUTURE_CONFIG);

      // Not an error: the whole point is that this build keeps running a config it only
      // partly understands, and keeps letting this machine edit and re-publish it.
      expect(await firefox.driver.findElement(By.id("cc-error")).getText()).toBe("");
      expect(await firefox.driver.findElement(By.id("cc-save")).isEnabled()).toBe(true);
      const warnings = await firefox.driver.findElement(By.id("cc-warnings")).getText();
      expect(warnings).toContain("sandbox");

      await firefox.driver.findElement(By.id("cc-save")).click();
      await firefox.driver.wait(
        async () => (await firefox.driver.findElement(By.id("cc-status")).getText()) === "Saved",
        10_000,
        "the editor never reported the config applied",
      );

      // The marker survives the save. Restamping here would compute a version from the keys
      // THIS build knows, strip the line, and disarm leniency on every other older machine
      // while the key it was hiding sat right there in the text.
      const value = await firefox.driver.findElement(By.id("cc-config")).getProperty("value");
      expect(value).toContain("version: 99");
      expect(value).toContain("sandbox: true");
    });
  });

  describe("with a seed that does not parse", () => {
    let firefox: Session;
    let serverPort: string;

    beforeAll(async () => {
      firefox = await launch({ extensions: ["probe", "cc"], configYaml: BROKEN_SEED });
      serverPort = new URL(firefox.serverUrl).port;
    });

    afterAll(async () => {
      await firefox?.close();
    });

    it("opens the editor itself and routes everything to a temporary container", async () => {
      // Every http URL is unmatched under the empty config, so this tab is reopened
      // into a throwaway; that is also what parks us on a probe-reported page.
      const url = `http://work.example:${serverPort}/?cb=broken-${Date.now()}`;
      try {
        await firefox.driver.get(url);
      } catch {
        // Reopened into a tmp container — expected.
      }
      await awaitContainerTab(firefox.driver, url);
      expect(await readContainerName(firefox.driver)).toMatch(/^tmp/);

      // CC called openOptionsPage() at startup, so the editor is already open.
      const tabs = await listTabs(firefox.driver);
      expect(tabs.some((tab) => tab.url === OPTIONS_URL)).toBe(true);

      // And it shows the parse error rather than a blank page. Polled for the same reason
      // openEditor waits: the message is written by the validate() that follows the page's
      // async fill, so reading once can catch the page a beat early — and an empty #cc-error
      // is also what a genuinely broken page would show.
      await switchToUrl(firefox.driver, OPTIONS_URL);
      await firefox.driver.wait(
        async () => (await firefox.driver.findElement(By.id("cc-error")).getText()) !== "",
        10_000,
        "the editor never reported the seed's parse error",
      );
    });
  });
});
