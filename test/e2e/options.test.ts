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

    it("shows the seeded config on first run", async () => {
      await openEditor("seed");
      const value = await firefox.driver.findElement(By.id("cc-config")).getAttribute("value");
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

    it("routes by the saved config after the reload", async () => {
      await openEditor("save");
      await typeConfig(EDITED_CONFIG);
      await firefox.driver.findElement(By.id("cc-save")).click();

      // runtime.reload() tears down every extension page, this tab included. Get off
      // it before touching the driver again.
      await firefox.driver.sleep(2000);
      const handles = await firefox.driver.getAllWindowHandles();
      await firefox.driver.switchTo().window(handles[0]!);

      // nomatch.example matched no rule before this edit; it must now land in Editor.
      // Drive it from a FRESH tab: CC keeps a tab that is already on a page and only
      // cancels its navigation, and a cancelled navigation never returns to the driver.
      const url = `http://nomatch.example:${serverPort}/?cb=edited-${Date.now()}`;
      await firefox.driver.switchTo().newWindow("tab");
      try {
        await firefox.driver.get(url);
      } catch {
        // CC reopens the blank tab into Editor, tearing this one down — expected.
      }
      await awaitContainerTab(firefox.driver, url);
      expect(await readContainerName(firefox.driver)).toBe("Editor");
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

      // And it shows the parse error rather than a blank page.
      await switchToUrl(firefox.driver, OPTIONS_URL);
      expect(await firefox.driver.findElement(By.id("cc-error")).getText()).not.toBe("");
    });
  });
});
