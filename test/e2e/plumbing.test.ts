import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, readCookieStoreId, type Session } from "../../harness/firefox";

describe("harness plumbing", () => {
  let session: Session;

  beforeAll(async () => {
    session = await launch();
  });

  afterAll(async () => {
    await session?.close();
  });

  it("reads the default cookieStoreId end-to-end", async () => {
    const page = await session.context.newPage();
    await page.goto(session.serverUrl);
    expect(await readCookieStoreId(page)).toBe("firefox-default");
  });
});
