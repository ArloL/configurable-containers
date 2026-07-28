import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
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
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  it("preserves the code parameter across the container switch", async () => {
    // Start from a page that has COMMITTED. Driving /authorize from a fresh tab would
    // have CC reopen that tab first, and the 302 would then be another hop of a
    // navigation the reopen guard already owns — no container switch, nothing proven.
    const authorize = `http://nomatch.example:${port}/authorize`;
    const article = `http://nomatch.example:${port}/?same=1&link=${encodeURIComponent(authorize)}`;
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(article);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const { name: from } = await awaitContainerTab(session.driver, article);
    expect(from).toMatch(/^tmp/);

    // Same-site link, so no reopen and no guard: the 302 out of it is the first
    // navigation CC gets to route, and work.example belongs in Work.
    await session.driver.findElement(By.id("go")).click();

    const callback = `http://work.example:${port}/callback`;
    const { name: landed } = await awaitContainerTab(session.driver, callback);
    expect(landed).toBe("Work");

    const opened = (await listTabs(session.driver)).find((t) => t.url.startsWith(callback));
    expect(opened, "the callback must have opened in its container").toBeDefined();
    expect(opened!.url).toContain(`code=${OAUTH_CODE}`);
  });
});

describe("redirect binding — a SAML POST binding (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  it("keeps the assertion, keeps the container, and says so", async () => {
    const idp = `http://nomatch.example:${port}/saml`;
    const article = `http://nomatch.example:${port}/?same=1&link=${encodeURIComponent(idp)}`;
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(article);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const { name: from } = await awaitContainerTab(session.driver, article);
    expect(from).toMatch(/^tmp/);

    // Same-site hop to the IdP, whose form then POSTs itself to work.example — a host
    // CC's rules put in Work. Reopening that POST would turn it into a GET.
    //
    // If this guard regresses, CC cancels that POST and the tab is left wedged
    // mid-navigation: every WebDriver call against it blocks, so the test dies of a
    // timeout rather than a named assertion. That timeout IS the regression signature
    // here, not flake — verified by backing the guard out. Nothing test-side can
    // improve it; a cancelled navigation never returns to WebDriver.
    await session.driver.findElement(By.id("go")).click();

    // Let the POST settle before touching the probe: its command relay lives in the
    // page's document, so a request issued mid-navigation loses its reply and times out.
    const acs = `http://work.example:${port}/acs`;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await session.driver.getCurrentUrl()).startsWith(acs)) {
      await session.driver.sleep(300);
    }
    expect(await session.driver.getCurrentUrl()).toMatch(acs);

    // The tab was never reopened, so the driver is still on it: the POST completed in
    // place, with its body, in the container it started in.
    expect(await readSeenPost(session.driver)).toContain(SAML_ASSERTION);
    expect(await readContainerName(session.driver)).toBe(from);

    // And it is the only tab at the destination — no reopened twin sitting in Work.
    const landed = (await listTabs(session.driver)).filter((t) => t.url.startsWith(acs));
    expect(landed).toHaveLength(1);
    expect(landed[0].container).toBe(from);

    const note = await readNotifications(session.driver, (n) => n.message.includes("work.example"));
    expect(note.title).toBe("Configurable Containers");
    expect(note.message).toContain(`stayed in ${from}`);
    expect(note.message).toContain("instead of Work");
  });
});
