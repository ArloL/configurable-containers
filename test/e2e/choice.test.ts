import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Key, error } from "selenium-webdriver";
import {
  launch, awaitContainerTab, awaitTab, awaitTabs, ccExtensionUrl, listTabs, type Session,
} from "../../harness/firefox";
import type { Page } from "../../harness/browser/index";

const CHOICE_URL = ccExtensionUrl("choice.html");

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
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(url);
    } catch {
      // CC cancelled the nav to show the choice page — expected.
    }
  }

  // The choice page, once CC has opened it. Every read below goes through it, so nothing
  // depends on which tab the driver was left on.
  const awaitChoicePage = (timeoutMs = 8000) =>
    firefox.browser.pageAt(CHOICE_URL, { timeout: timeoutMs });

  // getAttribute here is the W3C endpoint (Selenium's getDomAttribute), not the injected
  // atom Firefox refuses on an extension page — see harness/browser/locator.ts.
  async function optionKeyFor(choice: Page, container: string): Promise<string> {
    for (const option of await choice.locator("[data-cc-option]").all()) {
      if ((await option.getAttribute("data-container")) === container) {
        const key = await option.getAttribute("data-key");
        if (key) return key;
      }
    }
    throw new Error(`no choice option for container "${container}"`);
  }

  it("shows a keyboard choice screen for a multi-open-no-default rule and reopens into the chosen container", async () => {
    const url = `http://figma.example:${serverPort}/`;
    await navFreshTab(url);
    const choice = await awaitChoicePage();

    // The page rendered both options.
    const containers = await Promise.all(
      (await choice.locator("[data-cc-option]").all()).map((o) => o.getAttribute("data-container")),
    );
    expect(containers.sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["Personal", "Work"]);

    // Keyboard selection (the non-negotiable path).
    await choice.keyboard.press(await optionKeyFor(choice, "Work"));

    const { name: containerName } = await awaitContainerTab(firefox.browser, url);
    expect(containerName).toBe("Work");
  });

  // The container name of the option the page has focused, or null for none. The
  // highlight is where Enter goes, so this is the page's whole keyboard state.
  //
  // Asked as `:focus`, ordinary CSS, rather than through an injected script reading
  // document.activeElement — which this page would refuse. Nothing focused matches
  // nothing, and reads as null: the distinction this case exists to make.
  async function focusedOption(choice: Page): Promise<string | null> {
    const focused = choice.locator(":focus");
    if ((await focused.count()) === 0) return null;
    return focused.getAttribute("data-container");
  }

  async function optionOrder(choice: Page): Promise<string[]> {
    return Promise.all(
      (await choice.locator("[data-cc-option]").all()).map(
        async (o) => (await o.getAttribute("data-container")) ?? "",
      ),
    );
  }

  it("lands with an option already focused, so arrows and Enter are enough to choose", async () => {
    // The page used to render with focus nowhere, so an arrow and Enter — the first two
    // keys anyone tries — did nothing, and the hotkeys were the only way in.
    const url = `http://figma.example:${serverPort}/?arrow-enter`;
    await navFreshTab(url);
    const choice = await awaitChoicePage();

    const order = await optionOrder(choice);
    expect(await focusedOption(choice), "the page must take the keyboard as it renders").toBe(order[0]);

    await choice.keyboard.press(Key.ARROW_DOWN);
    expect(await focusedOption(choice)).toBe(order[1]);

    // Enter opens the highlighted one — the arrow moved the target, so this proves both.
    await choice.keyboard.press(Key.ENTER);
    const { name: containerName } = await awaitContainerTab(firefox.browser, url);
    expect(containerName).toBe(order[1]);
  });

  it("the underlined initial of a container name opens it directly", async () => {
    const url = `http://figma.example:${serverPort}/?mnemonic`;
    await navFreshTab(url);
    const choice = await awaitChoicePage();

    // "w" for Work, beside the positional "2": the accelerator you remember when the same
    // site is open in two containers every day.
    const mnemonic = choice.locator("[data-cc-option][data-mnemonic='w']");
    expect(await mnemonic.getAttribute("data-container")).toBe("Work");

    await choice.keyboard.press("w");
    const { name: containerName } = await awaitContainerTab(firefox.browser, url);
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
    const article = await awaitContainerTab(firefox.browser, articleUrl);

    // A same-tab link into a multi-open rule. The choice page used to load into THIS tab,
    // so the article was gone before anything had been chosen — the loss a single-container
    // reopen avoids by keeping the source tab.
    await article.page.locator("#go").click();

    await awaitTab(article.page, (tab) => tab.url.includes("/choice.html"));
    const tabs = await listTabs(article.page);

    const keptArticleTab = tabs.find((tab) => tab.url === articleUrl);
    const choiceTab = tabs.find((tab) => tab.url.includes("/choice.html"));
    expect(keptArticleTab, "the article must survive being asked to choose").toBeDefined();
    expect(keptArticleTab!.container).toBe(article.name);
    expect(choiceTab, "the choice must get a tab of its own").toBeDefined();
    expect(choiceTab!.index).toBe(keptArticleTab!.index + 1);

    // Choosing consumes the choice tab, leaving the container tab exactly where a
    // single-container reopen would have put it.
    const choice = await awaitChoicePage();
    await choice.keyboard.press(await optionKeyFor(choice, "Work"));
    const { name: chosenContainer } = await awaitContainerTab(firefox.browser, multiOpenUrl);
    expect(chosenContainer).toBe("Work");

    // Indices come from ONE fresh snapshot: a tab closing elsewhere renumbers every tab
    // after it, so an earlier reading is only good against itself. That snapshot is the one
    // awaitTabs settled on — the choice tab closing is an event with its own timing, and
    // reading the list once races it.
    const after = await awaitTabs(article.page, (tabs) => !tabs.some((t) => t.url.includes("/choice.html")));
    const articleStillOpen = after.find((tab) => tab.url === articleUrl);
    const chosenTab = after.find((tab) => tab.url.startsWith(multiOpenUrl));
    expect(articleStillOpen, "the article must survive the choice too").toBeDefined();
    expect(chosenTab!.index).toBe(articleStillOpen!.index + 1);
  });

  it("Esc cancels: the choice tab closes, and nothing was opened or lost", async () => {
    const multiOpenUrl = `http://figma.example:${serverPort}/?esc-cancels`;
    const articleUrl = `http://nomatch.example:${serverPort}/?same=1&link=${encodeURIComponent(multiOpenUrl)}`;
    await navFreshTab(articleUrl);
    const article = await awaitContainerTab(firefox.browser, articleUrl);

    await article.page.locator("#go").click();
    const choice = await awaitChoicePage();
    // Esc used to navigate this tab to the url, which in a tab of its own only earns
    // another choice page. Cancelling means closing it.
    try {
      await choice.keyboard.press(Key.ESCAPE);
    } catch (e) {
      // Esc closes the very tab the keystroke was delivered to, so whether the command's
      // reply beats the teardown is the browser's business rather than this case's: 154
      // answers first, 140 ESR raises NoSuchWindowError. Either way the keystroke landed,
      // and that the tab closed is what the assertions below are for.
      if (!(e instanceof error.NoSuchWindowError)) throw e;
    }

    // The choice tab closes under the driver; the article's own page is unaffected and
    // goes on relaying, with no re-attaching to do.
    const tabs = await awaitTabs(article.page, (all) => !all.some((tab) => tab.url.includes("/choice.html")));
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
    const { name: containerName } = await awaitContainerTab(firefox.browser, url);
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
    const choice = await awaitChoicePage();

    // The picker is restricted to the rule's open list.
    const containers = await Promise.all(
      (await choice.locator("[data-cc-option]").all()).map((o) => o.getAttribute("data-container")),
    );
    expect(containers.sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["Personal", "Temporary"]);

    await choice.keyboard.press(await optionKeyFor(choice, "Personal"));

    const { name: after } = await awaitContainerTab(firefox.browser, url);
    expect(after).toBe("Personal");
  });
});
