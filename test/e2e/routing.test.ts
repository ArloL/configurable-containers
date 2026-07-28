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
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  // Open a fresh firefox-default tab and navigate it; CC will cancel + reopen, so
  // the original tab may be torn down mid-nav — tolerate that.
  async function navFreshTab(url: string) {
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("routes a matching host into its named container", async () => {
    const url = `http://work.example:${port}/`;
    await navFreshTab(url);
    const { store, name } = await awaitContainerTab(session.driver, url);
    expect(store).toMatch(/^firefox-container-\d+$/);
    expect(name).toBe("Work");
  });

  it("routes an unmatched host into a fresh temporary container", async () => {
    const url = `http://nomatch.example:${port}/`;
    await navFreshTab(url);
    const { store, name } = await awaitContainerTab(session.driver, url);
    expect(store).toMatch(/^firefox-container-\d+$/);
    expect(name).toMatch(/^tmp/);
  });
});

// Own session: the assertion counts the throwaways that exist in the whole profile,
// so it must not inherit any from a neighbouring test.
describe("routing — a redirect chain is one navigation (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  it("lands the whole chain in the one throwaway opened for it", async () => {
    const final = `http://${REDIRECT_TARGET_HOST}:${port}/`;
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(`http://nomatch.example:${port}/redirect`);
    } catch {
      // CC reopened the tab away — expected.
    }

    // Firefox holds the reopened tab at about:blank until the chain commits, so every
    // hop after the first was a navigation CC saw as uncontained: each one used to buy
    // another throwaway, walking tmp1 -> tmp2 for a single click.
    const { name } = await awaitContainerTab(session.driver, final);
    expect(name).toMatch(/^tmp/);
    expect((await readContainerList(session.driver)).filter((c) => c.startsWith("tmp"))).toEqual([name]);
  });
});

describe("routing — a same-tab link that changes container (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  it("keeps the page you were on and opens the container tab beside it", async () => {
    const target = `http://work.example:${port}/`;
    const article = `http://nomatch.example:${port}/?same=1&link=${encodeURIComponent(target)}`;
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(article);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const { name: articleContainer } = await awaitContainerTab(session.driver, article);
    expect(articleContainer).toMatch(/^tmp/);

    // A plain same-tab link out of the article, into a host that belongs elsewhere.
    // The driver stays parked on the article tab: CC cancels the navigation instead
    // of tearing the tab down, which is the whole point.
    await session.driver.findElement(By.id("go")).click();

    const deadline = Date.now() + 15_000;
    let tabs = await listTabs(session.driver);
    while (Date.now() < deadline && !tabs.some((t) => t.url.startsWith(target))) {
      await session.driver.sleep(300);
      tabs = await listTabs(session.driver);
    }

    const kept = tabs.find((t) => t.url === article);
    const opened = tabs.find((t) => t.url.startsWith(target));
    expect(kept, "the article tab must survive the click").toBeDefined();
    expect(kept!.container).toBe(articleContainer); // still on its page, in its container
    expect(opened, "the link must open in its container").toBeDefined();
    expect(opened!.container).toBe("Work");
    expect(opened!.index).toBe(kept!.index + 1); // beside it, not somewhere else
  });
});

// Own session for the same reason: this counts throwaways profile-wide.
describe("routing — a link opened in a new tab (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  it("isolates it from the opener's throwaway", async () => {
    const target = `http://hop.example:${port}/`;
    const opener = `http://nomatch.example:${port}/?link=${encodeURIComponent(target)}`;
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(opener);
    } catch {
      // CC reopened the tab away — expected.
    }
    const first = await awaitContainerTab(session.driver, opener);
    expect(first.name).toMatch(/^tmp/);

    // A real click on a target=_blank link. Firefox opens a tab that INHERITS the
    // opener's container and reads about:blank until the click commits — the same
    // pre-commit state a redirect hop is in, but a different navigation, so it has to
    // be isolated rather than left where it landed.
    await session.driver.findElement(By.id("go")).click();

    const second = await awaitContainerTab(session.driver, target);
    expect(second.name).toMatch(/^tmp/);
    expect(second.name).not.toBe(first.name);
    expect((await readContainerList(session.driver)).filter((c) => c.startsWith("tmp")).sort()).toEqual(
      [first.name, second.name].sort(),
    );
  });
});
