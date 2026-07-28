import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By, Key } from "selenium-webdriver";
import { launch, awaitContainerTab, type Session } from "../../harness/firefox";

describe("choice screen + reopen picker (real Firefox, CC + probe)", () => {
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
      // CC cancelled the nav to show the choice page — expected.
    }
  }

  // Poll handles until one is on the choice page (moz-extension://.../choice.html).
  async function awaitChoicePage(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const handle of await firefox.driver.getAllWindowHandles()) {
        try {
          await firefox.driver.switchTo().window(handle);
          if ((await firefox.driver.getCurrentUrl()).includes("/choice.html")) return;
        } catch {
          // handle closed mid-loop — skip
        }
      }
      await firefox.driver.sleep(100);
    }
    throw new Error("choice page did not appear");
  }

  async function optionKeyFor(container: string): Promise<string> {
    const opts = await firefox.driver.findElements(By.css("[data-cc-option]"));
    for (const o of opts) {
      if ((await o.getAttribute("data-container")) === container) {
        const key = await o.getAttribute("data-key");
        if (key) return key;
      }
    }
    throw new Error(`no choice option for container "${container}"`);
  }

  it("shows a keyboard choice screen for a multi-open-no-default rule and reopens into the chosen container", async () => {
    const url = `http://figma.example:${serverPort}/`;
    await navFreshTab(url);
    await awaitChoicePage();

    // The page rendered both options.
    const opts = await firefox.driver.findElements(By.css("[data-cc-option]"));
    const containers = await Promise.all(opts.map((o) => o.getAttribute("data-container")));
    expect(containers.sort()).toEqual(["Personal", "Work"]);

    // Keyboard selection (the non-negotiable path).
    const workKey = await optionKeyFor("Work");
    await firefox.driver.actions().sendKeys(workKey).perform();

    const { name: containerName } = await awaitContainerTab(firefox.driver, url);
    expect(containerName).toBe("Work");
  });

  it("a choice is never remembered — a fresh nav re-shows the choice page", async () => {
    const url = `http://figma.example:${serverPort}/`;
    await navFreshTab(url);
    await awaitChoicePage();
    // The choice page reappeared (no auto-open of the Work container picked above).
    expect((await firefox.driver.getCurrentUrl()).includes("/choice.html")).toBe(true);
    // Clean up: close the choice tab so it doesn't satisfy later tests' awaitChoicePage.
    await firefox.driver.close();
    const handles = await firefox.driver.getAllWindowHandles();
    if (handles.length) await firefox.driver.switchTo().window(handles[0]);
  });

  // SKIPPED: Firefox `commands.onCommand` fires only on browser-CHROME key events, which
  // Selenium cannot synthesize in headless mode (W3C actions deliver to web content, not
  // chrome). The handler logic is fully covered by the L3 picker test (rule lookup,
  // restricted list, showChoice); the shared choice page + reopen are proven end to end
  // by the two choice-screen tests above. Re-enable when a chrome-key-capable driver
  // (or a programmatic command trigger) is available. See choice-screen design spec §8.
  it.skip("reopen picker: command on a default-Temporary tab offers the rule's list and reopens into Personal", async () => {
    const url = `http://youtube.example:${serverPort}/`;
    await navFreshTab(url);
    // Routes to a fresh tmp (default Temporary) — wait for it to settle.
    const { name: containerName } = await awaitContainerTab(firefox.driver, url);
    expect(containerName).toMatch(/^tmp/);

    // Invoke the reopen-picker keyboard command.
    await firefox.driver
      .actions()
      .keyDown(Key.CONTROL)
      .keyDown(Key.SHIFT)
      .sendKeys("o")
      .keyUp(Key.SHIFT)
      .keyUp(Key.CONTROL)
      .perform();
    await awaitChoicePage();

    // The picker is restricted to the rule's open list.
    const opts = await firefox.driver.findElements(By.css("[data-cc-option]"));
    const containers = await Promise.all(opts.map((o) => o.getAttribute("data-container")));
    expect(containers.sort()).toEqual(["Personal", "Temporary"]);

    const personalKey = await optionKeyFor("Personal");
    await firefox.driver.actions().sendKeys(personalKey).perform();

    const { name: after } = await awaitContainerTab(firefox.driver, url);
    expect(after).toBe("Personal");
  });
});
