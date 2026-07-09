import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch,
  readCookieStoreId,
  collectStoresUntilContainer,
  type Session,
} from "../../harness/firefox";

describe("harness plumbing", () => {
  let session: Session;

  beforeAll(async () => {
    session = await launch();
  });

  afterAll(async () => {
    await session?.close();
  });

  it("reads the default cookieStoreId end-to-end", async () => {
    await session.driver.get(session.serverUrl);
    expect(await readCookieStoreId(session.driver)).toBe("firefox-default");
  });

  it("observes a non-default container store", async () => {
    const stores = await collectStoresUntilContainer(session.driver, session.serverUrl);
    expect(stores).toContain("firefox-default");
    expect(stores.some((s) => /^firefox-container-\d+$/.test(s))).toBe(true);
  });
});
