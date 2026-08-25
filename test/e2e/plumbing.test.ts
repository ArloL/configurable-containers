import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch,
  readCookieStoreId,
  collectStoresUntilContainer,
  type Session,
} from "../../harness/firefox";

describe("harness plumbing", () => {
  let firefox: Session;

  beforeAll(async () => {
    firefox = await launch();
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("reads the default cookieStoreId end-to-end", async () => {
    const page = await firefox.browser.newPage();
    await page.goto(firefox.serverUrl);
    expect(await readCookieStoreId(page)).toBe("firefox-default");
  });

  it("observes a non-default container store", async () => {
    const stores = await collectStoresUntilContainer(firefox.browser, firefox.serverUrl);
    expect(stores).toContain("firefox-default");
    expect(stores.some((s) => /^firefox-container-\d+$/.test(s))).toBe(true);
  });
});
