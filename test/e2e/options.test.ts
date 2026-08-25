import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, navigateToContainerTab, openExtensionPage, ccExtensionUrl, listTabs, type Session,
} from "../../harness/firefox";
import type { Page } from "../../harness/browser/index";
import "../../harness/browser/matchers";

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
    async function parkOnProbePage(tag: string): Promise<Page> {
      const url = `http://work.example:${serverPort}/?cb=${tag}-${Date.now()}`;
      return (await navigateToContainerTab(firefox.browser, url)).page;
    }

    // The page fills #cc-config from `storage.local` AFTER it renders, and a tab is
    // reachable by url before its document exists — so the editor is reachable a beat
    // before it is populated, and a beat before that it is not there at all.
    // Measured on 140 ESR: one first read in twelve came back empty, hydrating 13ms later.
    // It is not a slow machine's problem either. `getAttribute` used to absorb the gap by
    // accident, being a script Selenium injects rather than a protocol command, and the
    // faster call that replaced it turned a standing race into a red main.
    //
    // So every case waits for the text before touching the editor, typeConfig included:
    // an async fill landing after clear() + sendKeys() would overwrite the config just
    // typed, and that failure would read as the editor ignoring input.
    async function openEditor(tag: string): Promise<Page> {
      const relay = await parkOnProbePage(tag);
      await openExtensionPage(relay, OPTIONS_URL);
      const editor = await firefox.browser.pageAt(OPTIONS_URL);
      // The url commits before the document exists, and the document renders before the
      // fill lands. Two windows, both real — and both are now waits rather than races.
      await expect(editor.locator("#cc-config")).not.toHaveValue("", { timeout: 10_000 });
      return editor;
    }

    // Clear and TYPE, rather than assigning .value and dispatching a synthetic `input`:
    // Selenium's executeScript is a script injected into the page, and Firefox refuses to
    // run one in an extension page (harness/firefox.ts, on operating an extension page).
    // Element Clear and Element Send Keys are protocol commands rather than injected
    // script, and they fire the real `input` the editor validates on — which assigning
    // .value alone never did either, hence the dispatch this replaces.
    async function typeConfig(editor: Page, text: string) {
      await editor.locator("#cc-config").fill(text);
    }

    it("shows the seeded config on first run", async () => {
      const editor = await openEditor("seed");
      // The bundled test config was written to storage at first run.
      const value = await editor.locator("#cc-config").inputValue();
      expect(value).toContain("work.example");
      expect(value).toContain("redirect.example");
    });

    it("refuses to save a config that does not parse", async () => {
      const editor = await openEditor("invalid");
      await typeConfig(editor, "rules:\n  - match: 123\n    open: Nope\n");

      await expect(editor.locator("#cc-error")).not.toHaveText("");
      expect(await editor.locator("#cc-save").isEnabled()).toBe(false);

      // …and recovers when the text becomes valid again.
      await typeConfig(editor, EDITED_CONFIG);
      await expect(editor.locator("#cc-error")).toHaveText("");
      await expect(editor.locator("#cc-save")).toBeEnabled();
    });

    it("routes by the saved config once the editor reports it applied", async () => {
      // This case ran nowhere below Firefox 154 until the save stopped reloading the
      // extension: `runtime.reload()` does not bring a TEMPORARILY installed one back on
      // 140.14.0esr, so the OLD background went on applying the OLD config while the editor
      // reported success. That was the only case the ESR leg could not observe, and the
      // whole reason a save now applies its config in place.

      const editor = await openEditor("save");
      await typeConfig(editor, EDITED_CONFIG);
      await editor.locator("#cc-save").click();

      // The status is written when the background answers, so this is a real
      // synchronisation point rather than a guess at how long a restart takes. It is also
      // the assertion the old path could not make: "Saved" used to be printed before
      // anything had been applied.
      await expect(editor.locator("#cc-status")).toHaveText("Saved", { timeout: 10_000 });

      // nomatch.example matched no rule before this edit; it must now land in Editor.
      // Still polled: the status says the config is live, and what is asserted below is the
      // routing that follows from it, one navigation later. Each attempt is a FRESH tab,
      // which navigateToContainerTab guarantees.
      const deadline = Date.now() + 20_000;
      let container = "";
      while (Date.now() < deadline && container !== "Editor") {
        const url = `http://nomatch.example:${serverPort}/?cb=edited-${Date.now()}`;
        container = (await navigateToContainerTab(firefox.browser, url)).name;
      }
      expect(container, "the saved config never took effect").toBe("Editor");
    });

    it("stamps the version a saved config earns", async () => {
      const editor = await openEditor("stamp");
      await typeConfig(editor, PATTERN_CONFIG);
      await editor.locator("#cc-save").click();
      await expect(editor.locator("#cc-status")).toHaveText("Saved", { timeout: 10_000 });

      // Back in the editor, because the stored text and the text on screen must be the
      // same text — the line is derived, and a user who never learns the number still gets
      // the benefit of it on their other machines.
      await expect(editor.locator("#cc-config")).toHaveValue(/version: 2/);
    });

    it("edits and saves a config written by a newer build without losing what it cannot read", async () => {
      const editor = await openEditor("future");
      await typeConfig(editor, FUTURE_CONFIG);

      // Not an error: the whole point is that this build keeps running a config it only
      // partly understands, and keeps letting this machine edit and re-publish it.
      await expect(editor.locator("#cc-error")).toHaveText("");
      await expect(editor.locator("#cc-save")).toBeEnabled();
      await expect(editor.locator("#cc-warnings")).toContainText("sandbox");

      await editor.locator("#cc-save").click();
      await expect(editor.locator("#cc-status")).toHaveText("Saved", { timeout: 10_000 });

      // The marker survives the save. Restamping here would compute a version from the keys
      // THIS build knows, strip the line, and disarm leniency on every other older machine
      // while the key it was hiding sat right there in the text.
      const saved = editor.locator("#cc-config");
      await expect(saved).toHaveValue(/version: 99/);
      await expect(saved).toHaveValue(/sandbox: true/);
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
      const relay = await navigateToContainerTab(firefox.browser, url);
      expect(relay.name).toMatch(/^tmp/);

      // CC called openOptionsPage() at startup, so the editor is already open.
      const tabs = await listTabs(relay.page);
      expect(tabs.some((tab) => tab.url === OPTIONS_URL)).toBe(true);

      // And it shows the parse error rather than a blank page. The assertion is what
      // waits: the message is written by the validate() that follows the page's async
      // fill, so reading once can catch the page a beat early — and an empty #cc-error is
      // also what a genuinely broken page would show.
      const editor = await firefox.browser.pageAt(OPTIONS_URL);
      await expect(editor.locator("#cc-error")).not.toHaveText("", { timeout: 10_000 });
    });
  });
});
