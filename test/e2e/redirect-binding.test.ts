import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import { launch, awaitContainerTab, listTabs, type Session } from "../../harness/firefox";
import { OAUTH_CODE } from "../../harness/server";

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
