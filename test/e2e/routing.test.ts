import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import {
  launch,
  awaitContainerTab,
  readContainerList,
  listTabs,
  type Session,
} from "../../harness/firefox";
import { REDIRECT_TARGET_HOST } from "../../harness/server";

describe("routing (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  // Open a fresh firefox-default tab and navigate it; CC will cancel + reopen, so
  // the original tab may be torn down mid-nav — tolerate that.
  async function navFreshTab(url: string) {
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("routes a matching host into its named container", async () => {
    const matchedHostUrl = `http://work.example:${serverPort}/`;
    await navFreshTab(matchedHostUrl);
    const { store: cookieStoreId, name: containerName } = await awaitContainerTab(firefox.driver, matchedHostUrl);
    expect(cookieStoreId).toMatch(/^firefox-container-\d+$/);
    expect(containerName).toBe("Work");
  });

  it("routes an unmatched host into a fresh temporary container", async () => {
    const unmatchedHostUrl = `http://nomatch.example:${serverPort}/`;
    await navFreshTab(unmatchedHostUrl);
    const { store: cookieStoreId, name: containerName } = await awaitContainerTab(firefox.driver, unmatchedHostUrl);
    expect(cookieStoreId).toMatch(/^firefox-container-\d+$/);
    expect(containerName).toMatch(/^tmp/);
  });
});

// Own session: the assertion counts the throwaways that exist in the whole profile,
// so it must not inherit any from a neighbouring test.
describe("routing — a redirect chain is one navigation (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("lands the whole chain in the one throwaway opened for it", async () => {
    const chainDestination = `http://${REDIRECT_TARGET_HOST}:${serverPort}/`;
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(`http://nomatch.example:${serverPort}/redirect`);
    } catch {
      // CC reopened the tab away — expected.
    }

    // Firefox holds the reopened tab at about:blank until the chain commits, so every
    // hop after the first was a navigation CC saw as uncontained: each one used to buy
    // another throwaway, walking tmp1 -> tmp2 for a single click.
    const { name: containerName } = await awaitContainerTab(firefox.driver, chainDestination);
    expect(containerName).toMatch(/^tmp/);
    expect((await readContainerList(firefox.driver)).filter((c) => c.startsWith("tmp"))).toEqual([containerName]);
  });
});

describe("routing — a same-tab link that changes container (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("keeps the page you were on and opens the container tab beside it", async () => {
    const linkTargetUrl = `http://work.example:${serverPort}/`;
    const articleUrl = `http://nomatch.example:${serverPort}/?same=1&link=${encodeURIComponent(linkTargetUrl)}`;
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(articleUrl);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const { name: articleContainer } = await awaitContainerTab(firefox.driver, articleUrl);
    expect(articleContainer).toMatch(/^tmp/);

    // A plain same-tab link out of the articleUrl, into a host that belongs elsewhere.
    // The driver stays parked on the articleUrl tab: CC cancels the navigation instead
    // of tearing the tab down, which is the whole point.
    await firefox.driver.findElement(By.id("go")).click();

    const deadline = Date.now() + 15_000;
    let tabs = await listTabs(firefox.driver);
    while (Date.now() < deadline && !tabs.some((tab) => tab.url.startsWith(linkTargetUrl))) {
      await firefox.driver.sleep(300);
      tabs = await listTabs(firefox.driver);
    }

    const keptArticleTab = tabs.find((tab) => tab.url === articleUrl);
    const openedContainerTab = tabs.find((tab) => tab.url.startsWith(linkTargetUrl));
    expect(keptArticleTab, "the article tab must survive the click").toBeDefined();
    expect(keptArticleTab!.container).toBe(articleContainer); // still on its page, in its container
    expect(openedContainerTab, "the link must open in its container").toBeDefined();
    expect(openedContainerTab!.container).toBe("Work");
    expect(openedContainerTab!.index).toBe(keptArticleTab!.index + 1); // beside it, not somewhere else
  });
});

// Own session for the same reason: this counts throwaways profile-wide.
describe("routing — a link opened in a new tab (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("isolates it from the openerUrl's throwaway", async () => {
    const linkTargetUrl = `http://hop.example:${serverPort}/`;
    const openerUrl = `http://nomatch.example:${serverPort}/?link=${encodeURIComponent(linkTargetUrl)}`;
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(openerUrl);
    } catch {
      // CC reopened the tab away — expected.
    }
    const openersContainer = await awaitContainerTab(firefox.driver, openerUrl);
    expect(openersContainer.name).toMatch(/^tmp/);

    // A real click on a target=_blank link. Firefox opens a tab that INHERITS the
    // openerUrl's container and reads about:blank until the click commits — the same
    // pre-commit state a redirect hop is in, but a different navigation, so it has to
    // be isolated rather than left where it landed.
    await firefox.driver.findElement(By.id("go")).click();

    const linkedTabsContainer = await awaitContainerTab(firefox.driver, linkTargetUrl);
    expect(linkedTabsContainer.name).toMatch(/^tmp/);
    expect(linkedTabsContainer.name).not.toBe(openersContainer.name);
    expect((await readContainerList(firefox.driver)).filter((c) => c.startsWith("tmp")).sort()).toEqual(
      [openersContainer.name, linkedTabsContainer.name].sort(),
    );
  });
});

describe("routing — a window.open popup (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("routes it without destroying the popup window it was given", async () => {
    const shareTargetUrl = `http://work.example:${serverPort}/`;
    const articleUrl = `http://nomatch.example:${serverPort}/?popup=1&link=${encodeURIComponent(shareTargetUrl)}`;
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(articleUrl);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    await awaitContainerTab(firefox.driver, articleUrl);
    const articleTab = (await listTabs(firefox.driver)).find((tab) => tab.url === articleUrl)!;

    // A share button: window.open(url, "share", "width=640,height=480"). Firefox gives
    // it a window of its own, whose tab is pre-commit and so takes the REPLACE branch of
    // a reopen. The replacement used to be created with no window at all, which lands it
    // in the last focused normal window — removing the original then closed the popup and
    // took the navigation with it. The driver stays parked on the article: window.open
    // does not navigate this tab, so its command relay survives.
    await firefox.driver.findElement(By.id("go")).click();

    const deadline = Date.now() + 15_000;
    let tabs = await listTabs(firefox.driver);
    while (Date.now() < deadline && !tabs.some((tab) => tab.url.startsWith(shareTargetUrl))) {
      await firefox.driver.sleep(300);
      tabs = await listTabs(firefox.driver);
    }

    const routedShareTab = tabs.find((tab) => tab.url.startsWith(shareTargetUrl));
    expect(routedShareTab, "the share popup must still reach its container").toBeDefined();
    expect(routedShareTab!.container).toBe("Work");
    // The decisive bit: it is in the popup's window, not the one the article is in.
    expect(routedShareTab!.windowId).not.toBe(articleTab.windowId);
  });
});
