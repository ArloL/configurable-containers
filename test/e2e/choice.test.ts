import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By, Key, error } from "selenium-webdriver";
import { launch, awaitContainerTab, listTabs, type Session } from "../../harness/firefox";

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
    expect(containers.sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["Personal", "Work"]);

    // Keyboard selection (the non-negotiable path).
    const workKey = await optionKeyFor("Work");
    await firefox.driver.actions().sendKeys(workKey).perform();

    const { name: containerName } = await awaitContainerTab(firefox.driver, url);
    expect(containerName).toBe("Work");
  });

  // The container name of the option the page has focused, or null for none. The
  // highlight is where Enter goes, so this is the page's whole keyboard state.
  async function focusedOption(): Promise<string | null> {
    return firefox.driver.executeScript<string | null>(
      "return document.activeElement && document.activeElement.getAttribute('data-container')",
    );
  }

  async function optionOrder(): Promise<string[]> {
    const opts = await firefox.driver.findElements(By.css("[data-cc-option]"));
    return Promise.all(opts.map(async (o) => (await o.getAttribute("data-container")) ?? ""));
  }

  it("lands with an option already focused, so arrows and Enter are enough to choose", async () => {
    // The page used to render with focus nowhere, so an arrow and Enter — the first two
    // keys anyone tries — did nothing, and the hotkeys were the only way in.
    const url = `http://figma.example:${serverPort}/?arrow-enter`;
    await navFreshTab(url);
    await awaitChoicePage();

    const order = await optionOrder();
    expect(await focusedOption(), "the page must take the keyboard as it renders").toBe(order[0]);

    await firefox.driver.actions().sendKeys(Key.ARROW_DOWN).perform();
    expect(await focusedOption()).toBe(order[1]);

    // Enter opens the highlighted one — the arrow moved the target, so this proves both.
    await firefox.driver.actions().sendKeys(Key.ENTER).perform();
    const { name: containerName } = await awaitContainerTab(firefox.driver, url);
    expect(containerName).toBe(order[1]);
  });

  it("the underlined initial of a container name opens it directly", async () => {
    const url = `http://figma.example:${serverPort}/?mnemonic`;
    await navFreshTab(url);
    await awaitChoicePage();

    // "w" for Work, beside the positional "2": the accelerator you remember when the same
    // site is open in two containers every day.
    const opts = await firefox.driver.findElements(By.css("[data-cc-option][data-mnemonic='w']"));
    expect(await opts[0]?.getAttribute("data-container")).toBe("Work");

    await firefox.driver.actions().sendKeys("w").perform();
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
    if (handles.length) await firefox.driver.switchTo().window(handles[0]!);
  });

  it("keeps the page you were on while you choose, and lands the choice beside it", async () => {
    // Its own query string: earlier cases leave figma.example tabs open in this session,
    // and a bare host url would match those instead.
    const multiOpenUrl = `http://figma.example:${serverPort}/?keeps-the-page`;
    const articleUrl = `http://nomatch.example:${serverPort}/?same=1&link=${encodeURIComponent(multiOpenUrl)}`;
    await navFreshTab(articleUrl);
    const { name: articleContainer } = await awaitContainerTab(firefox.driver, articleUrl);

    // A same-tab link into a multi-open rule. The choice page used to load into THIS tab,
    // so the article was gone before anything had been chosen — the loss a single-container
    // reopen avoids by keeping the source tab.
    await firefox.driver.findElement(By.id("go")).click();

    const deadline = Date.now() + 15_000;
    let tabs = await listTabs(firefox.driver);
    while (Date.now() < deadline && !tabs.some((tab) => tab.url.includes("/choice.html"))) {
      await firefox.driver.sleep(300);
      tabs = await listTabs(firefox.driver);
    }

    const keptArticleTab = tabs.find((tab) => tab.url === articleUrl);
    const choiceTab = tabs.find((tab) => tab.url.includes("/choice.html"));
    expect(keptArticleTab, "the article must survive being asked to choose").toBeDefined();
    expect(keptArticleTab!.container).toBe(articleContainer);
    expect(choiceTab, "the choice must get a tab of its own").toBeDefined();
    expect(choiceTab!.index).toBe(keptArticleTab!.index + 1);

    // Choosing consumes the choice tab, leaving the container tab exactly where a
    // single-container reopen would have put it.
    await awaitChoicePage();
    await firefox.driver.actions().sendKeys(await optionKeyFor("Work")).perform();
    const { name: chosenContainer } = await awaitContainerTab(firefox.driver, multiOpenUrl);
    expect(chosenContainer).toBe("Work");

    // Indices come from ONE fresh snapshot: a tab closing elsewhere renumbers every tab
    // after it, so an earlier reading is only good against itself.
    const after = await listTabs(firefox.driver);
    const articleStillOpen = after.find((tab) => tab.url === articleUrl);
    const chosenTab = after.find((tab) => tab.url.startsWith(multiOpenUrl));
    expect(after.some((tab) => tab.url.includes("/choice.html"))).toBe(false);
    expect(articleStillOpen, "the article must survive the choice too").toBeDefined();
    expect(chosenTab!.index).toBe(articleStillOpen!.index + 1);
  });

  it("Esc cancels: the choice tab closes, and nothing was opened or lost", async () => {
    const multiOpenUrl = `http://figma.example:${serverPort}/?esc-cancels`;
    const articleUrl = `http://nomatch.example:${serverPort}/?same=1&link=${encodeURIComponent(multiOpenUrl)}`;
    await navFreshTab(articleUrl);
    await awaitContainerTab(firefox.driver, articleUrl); // leaves the driver on the article
    const articleHandle = await firefox.driver.getWindowHandle();

    await firefox.driver.findElement(By.id("go")).click();
    await awaitChoicePage();
    // Esc used to navigate this tab to the url, which in a tab of its own only earns
    // another choice page. Cancelling means closing it.
    try {
      await firefox.driver.actions().sendKeys(Key.ESCAPE).perform();
    } catch (e) {
      // Esc closes the very tab the keystroke was delivered to, so whether the command's
      // reply beats the teardown is the browser's business rather than this case's: 154
      // answers first, 140 ESR raises NoSuchWindowError. Either way the keystroke landed,
      // and that the tab closed is what the assertions below are for.
      if (!(e instanceof error.NoSuchWindowError)) throw e;
    }

    // The choice tab closes under the driver, so observe from the article's own tab.
    await firefox.driver.switchTo().window(articleHandle);
    const deadline = Date.now() + 8000;
    let tabs = await listTabs(firefox.driver);
    while (Date.now() < deadline && tabs.some((tab) => tab.url.includes("/choice.html"))) {
      await firefox.driver.sleep(200);
      tabs = await listTabs(firefox.driver);
    }

    expect(tabs.some((tab) => tab.url.includes("/choice.html"))).toBe(false);
    expect(tabs.some((tab) => tab.url === articleUrl), "the article is untouched").toBe(true);
    expect(tabs.some((tab) => tab.url.startsWith(multiOpenUrl)), "nothing was opened").toBe(false);
  });

  // SKIPPED: `commands.onCommand` fires only on browser-CHROME key events, which Selenium
  // cannot synthesize (W3C actions deliver to web content). The handler logic is covered by
  // the L3 picker test, and the shared choice page and reopen by the two cases above.
  // Re-enable when a chrome-key-capable driver is available. Design spec §8.
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
    expect(containers.sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["Personal", "Temporary"]);

    const personalKey = await optionKeyFor("Personal");
    await firefox.driver.actions().sendKeys(personalKey).perform();

    const { name: after } = await awaitContainerTab(firefox.driver, url);
    expect(after).toBe("Personal");
  });
});
