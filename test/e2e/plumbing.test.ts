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
    await firefox.driver.get(firefox.serverUrl);
    expect(await readCookieStoreId(firefox.driver)).toBe("firefox-default");
  });

  it("observes a non-default container store", async () => {
    const stores = await collectStoresUntilContainer(firefox.driver, firefox.serverUrl);
    expect(stores).toContain("firefox-default");
    expect(stores.some((s) => /^firefox-container-\d+$/.test(s))).toBe(true);
  });
});
