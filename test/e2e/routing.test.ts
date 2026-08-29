import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch,
  awaitContainerTab,
  awaitTab,
  readContainerList,
  listTabs,
  type Session,
} from "../../harness/firefox";
import { REDIRECT_TARGET_HOST } from "../../harness/server";

describe("routing (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  // Open a fresh firefox-default tab and navigate it. CC cancels and reopens, so the
  // original tab may be torn down mid-nav.
  async function navFreshTab(url: string) {
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("routes a matching host into its named container", async () => {
    const matchedHostUrl = `http://work.example:${serverPort}/`;
    await navFreshTab(matchedHostUrl);
    const { store: cookieStoreId, name: containerName } = await awaitContainerTab(firefox.browser, matchedHostUrl);
    expect(cookieStoreId).toMatch(/^firefox-container-\d+$/);
    expect(containerName).toBe("Work");
  });

  it("routes an unmatched host into a fresh temporary container", async () => {
    const unmatchedHostUrl = `http://nomatch.example:${serverPort}/`;
    await navFreshTab(unmatchedHostUrl);
    const { store: cookieStoreId, name: containerName } = await awaitContainerTab(firefox.browser, unmatchedHostUrl);
    expect(cookieStoreId).toMatch(/^firefox-container-\d+$/);
    expect(containerName).toMatch(/^tmp/);
  });
});

// Own session: the assertion counts throwaways profile-wide, so it must not inherit any
// from a neighbouring test.
describe("routing — a redirect chain is one navigation (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("lands the whole chain in the one throwaway opened for it", async () => {
    const chainDestination = `http://${REDIRECT_TARGET_HOST}:${serverPort}/`;
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(`http://nomatch.example:${serverPort}/redirect`);
    } catch {
      // CC reopened the tab away — expected.
    }

    // Firefox holds the reopened tab at about:blank until the chain commits, so every hop
    // after the first looked uncontained and used to buy another throwaway: tmp1 -> tmp2
    // for a single click.
    const { page, name: containerName } = await awaitContainerTab(firefox.browser, chainDestination);
    expect(containerName).toMatch(/^tmp/);
    expect((await readContainerList(page)).filter((c) => c.startsWith("tmp"))).toEqual([containerName]);
  });
});

describe("routing — a same-tab link that changes container (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("keeps the page you were on and opens the container tab beside it", async () => {
    const linkTargetUrl = `http://work.example:${serverPort}/`;
    const articleUrl = `http://nomatch.example:${serverPort}/?same=1&link=${encodeURIComponent(linkTargetUrl)}`;
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(articleUrl);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const article = await awaitContainerTab(firefox.browser, articleUrl);
    expect(article.name).toMatch(/^tmp/);

    // A plain same-tab link out of articleUrl into a host that belongs elsewhere. The
    // article page survives the click: CC cancels the navigation instead of tearing the
    // tab down, which is the point — and it goes on relaying probe commands because of it.
    await article.page.locator("#go").click();

    await awaitTab(article.page, (tab) => tab.url.startsWith(linkTargetUrl));
    const tabs = await listTabs(article.page);

    const keptArticleTab = tabs.find((tab) => tab.url === articleUrl);
    const openedContainerTab = tabs.find((tab) => tab.url.startsWith(linkTargetUrl));
    expect(keptArticleTab, "the article tab must survive the click").toBeDefined();
    expect(keptArticleTab!.container).toBe(article.name); // still on its page, in its container
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
    firefox = await launch({ extensions: ["cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("isolates it from the openerUrl's throwaway", async () => {
    const linkTargetUrl = `http://hop.example:${serverPort}/`;
    const openerUrl = `http://nomatch.example:${serverPort}/?link=${encodeURIComponent(linkTargetUrl)}`;
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(openerUrl);
    } catch {
      // CC reopened the tab away — expected.
    }
    const openersContainer = await awaitContainerTab(firefox.browser, openerUrl);
    expect(openersContainer.name).toMatch(/^tmp/);

    // A real click on a target=_blank link. Firefox opens a tab that INHERITS the opener's
    // container and reads about:blank until the click commits — the same pre-commit state
    // as a redirect hop, but a different navigation, so it must be isolated.
    await openersContainer.page.locator("#go").click();

    const linkedTabsContainer = await awaitContainerTab(firefox.browser, linkTargetUrl);
    expect(linkedTabsContainer.name).toMatch(/^tmp/);
    expect(linkedTabsContainer.name).not.toBe(openersContainer.name);
    expect(
      (await readContainerList(linkedTabsContainer.page)).filter((c) => c.startsWith("tmp")).sort(),
    ).toEqual([openersContainer.name, linkedTabsContainer.name].sort());
  });
});

// The counterpart to the case above, answering the other way: a link opened in a new tab
// to the site it was clicked ON. That tab is pre-commit on about:blank, so nothing about
// it says which session it belongs to — only the container it inherited and the page the
// click came from. Reported: opening a video from a YouTube search result in a new tab put
// it in a SECOND throwaway, logged out.
describe("routing — a same-site link opened in a new tab (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("keeps the throwaway the click came from", async () => {
    const linkTargetUrl = `http://nomatch.example:${serverPort}/watch`;
    const openerUrl = `http://nomatch.example:${serverPort}/?link=${encodeURIComponent(linkTargetUrl)}`;
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(openerUrl);
    } catch {
      // CC reopened the tab away — expected.
    }
    const openersContainer = await awaitContainerTab(firefox.browser, openerUrl);
    expect(openersContainer.name).toMatch(/^tmp/);

    await openersContainer.page.locator("#go").click();

    const linkedTabsContainer = await awaitContainerTab(firefox.browser, linkTargetUrl);
    expect(linkedTabsContainer.name).toBe(openersContainer.name);
    // And no second one was minted on the way: the tab was left where Firefox put it.
    expect((await readContainerList(linkedTabsContainer.page)).filter((c) => c.startsWith("tmp"))).toEqual([
      openersContainer.name,
    ]);
  });
});

describe("routing — a window.open popup (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("routes it without destroying the popup window it was given", async () => {
    const shareTargetUrl = `http://work.example:${serverPort}/`;
    const articleUrl = `http://nomatch.example:${serverPort}/?popup=1&link=${encodeURIComponent(shareTargetUrl)}`;
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(articleUrl);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const article = await awaitContainerTab(firefox.browser, articleUrl);
    const articleTab = (await listTabs(article.page)).find((tab) => tab.url === articleUrl)!;

    // A share button: window.open(url, "share", "width=640,height=480"). Firefox gives it
    // its own window, whose tab is pre-commit and so takes the REPLACE branch. The
    // replacement used to be created with no window at all, landing in the last focused
    // normal window — removing the original then closed the popup and took the navigation
    // with it. The article page is untouched by all this, so it goes on relaying.
    await article.page.locator("#go").click();

    await awaitTab(article.page, (tab) => tab.url.startsWith(shareTargetUrl));
    const tabs = await listTabs(article.page);

    const routedShareTab = tabs.find((tab) => tab.url.startsWith(shareTargetUrl));
    expect(routedShareTab, "the share popup must still reach its container").toBeDefined();
    expect(routedShareTab!.container).toBe("Work");
    // The decisive bit: it is in the popup's window, not the one the article is in.
    expect(routedShareTab!.windowId).not.toBe(articleTab.windowId);
  });
});
