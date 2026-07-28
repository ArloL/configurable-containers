import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitContainerTab, readScriptAtStart, readLocalStorage, readCookieNamesHere, type Session,
} from "../../harness/firefox";

describe("scripts overlay (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

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
