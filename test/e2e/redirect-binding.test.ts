import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch,
  awaitContainerTab,
  listTabs,
  readContainerName,
  readNotifications,
  readSeenPost,
  type Session,
} from "../../harness/firefox";
import { OAUTH_CODE, SAML_ASSERTION } from "../../harness/server";

describe("redirect binding — an OAuth code flow (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("preserves the code parameter across the container switch", async () => {
    // Start from a page that has COMMITTED. Driving /authorize from a fresh tab would
    // have CC reopen that tab first, and the 302 would then be another hop of a
    // navigation the reopen guard already owns — no container switch, nothing proven.
    const authorize = `http://nomatch.example:${serverPort}/authorize`;
    const article = `http://nomatch.example:${serverPort}/?same=1&link=${encodeURIComponent(authorize)}`;
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(article);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const from = await awaitContainerTab(firefox.browser, article);
    expect(from.name).toMatch(/^tmp/);

    // Same-site link, so no reopen and no guard: the 302 out of it is the first
    // navigation CC gets to route, and work.example belongs in Work.
    await from.page.locator("#go").click();

    const callback = `http://work.example:${serverPort}/callback`;
    const landedTab = await awaitContainerTab(firefox.browser, callback);
    expect(landedTab.name).toBe("Work");

    const opened = (await listTabs(landedTab.page)).find((tab) => tab.url.startsWith(callback));
    expect(opened, "the callback must have opened in its container").toBeDefined();
    expect(opened!.url).toContain(`code=${OAUTH_CODE}`);
  });
});

describe("redirect binding — a SAML POST binding (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("keeps the assertion, keeps the container, and says so", async () => {
    const idp = `http://nomatch.example:${serverPort}/saml`;
    const article = `http://nomatch.example:${serverPort}/?same=1&link=${encodeURIComponent(idp)}`;
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(article);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const start = await awaitContainerTab(firefox.browser, article);
    expect(start.name).toMatch(/^tmp/);

    // Same-site hop to the IdP, whose form then POSTs itself to work.example — a host
    // CC's rules put in Work. Reopening that POST would turn it into a GET.
    //
    // If this guard regresses, CC cancels that POST and the tab is left wedged
    // mid-navigation: every WebDriver call against it blocks, so the test dies of a
    // timeout rather than a named assertion. That timeout IS the regression signature
    // here, not flake — verified by backing the guard out. Nothing test-side can
    // improve it; a cancelled navigation never returns to WebDriver.
    await start.page.locator("#go").click();

    // Let the POST settle before touching the probe: its command relay lives in the
    // page's document, so a request issued mid-navigation loses its reply and times out.
    const acs = `http://work.example:${serverPort}/acs`;
    await start.page.waitForURL(acs, { timeout: 20_000 });

    // The tab was never reopened — it is the same page throughout: the POST completed in
    // place, with its body, in the container it started in.
    expect(await readSeenPost(start.page)).toContain(SAML_ASSERTION);
    expect(await readContainerName(start.page)).toBe(start.name);

    // And it is the only tab at the destination — no reopened twin sitting in Work.
    const landed = (await listTabs(start.page)).filter((tab) => tab.url.startsWith(acs));
    expect(landed).toHaveLength(1);
    expect(landed[0]!.container).toBe(start.name);

    const note = await readNotifications(start.page, (n) => n.message.includes("work.example"));
    expect(note.title).toBe("Configurable Containers");
    expect(note.message).toContain(`stayed in ${start.name}`);
    expect(note.message).toContain("instead of Work");
  });
});
