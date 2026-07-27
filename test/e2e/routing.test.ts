import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, awaitContainerTab, type Session } from "../../harness/firefox";

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
