import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, awaitContainerTab, type Session } from "../../harness/firefox";

describe("redirector auto-close (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"], ccRedirectorDelayMs: 200 });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  async function navFreshTab(url: string): Promise<void> {
    // The previous case leaves the driver on a tab CC closed, and newWindow needs a
    // live context ("Browsing context has been discarded") — re-anchor first.
    const handles = await session.driver.getAllWindowHandles();
    await session.driver.switchTo().window(handles[handles.length - 1]);
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(url);
    } catch {
      // CC may reopen the tab away — expected for non-redirector hosts.
    }
  }

  // Poll window handles until none shows `url` (the tab was closed), or time out.
  async function waitForTabGone(url: string, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const handles = await session.driver.getAllWindowHandles();
      let present = false;
      for (const handle of handles) {
        try {
          await session.driver.switchTo().window(handle);
          if ((await session.driver.getCurrentUrl()).startsWith(url)) {
            present = true;
            break;
          }
        } catch {
          // handle closed mid-loop — skip.
        }
      }
      if (!present) return true; // gone
      await session.driver.sleep(100);
    }
    return false;
  }

  it("closes a redirector tab after the delay when it stays on the shim domain", async () => {
    const url = `http://redirect.example:${port}/`;
    await navFreshTab(url);
    // The redirector tab stays in whatever container it opened in (redirector → stay),
    // so it loads normally. After the short delay (200ms) the closer closes it.
    const gone = await waitForTabGone(url, 5000);
    expect(gone).toBe(true);
  });

  it("does NOT close a non-redirector tab after the same delay", async () => {
    const url = `http://work.example:${port}/`;
    await navFreshTab(url);
    // work.example routes to the Work container — awaitContainerTab leaves the driver
    // focused on the reopened Work tab.
    const { name } = await awaitContainerTab(session.driver, url);
    expect(name).toBe("Work");
    // Wait well past the redirector delay; the Work tab must survive.
    await session.driver.sleep(1000);
    const stillThere = (await session.driver.getCurrentUrl()).startsWith(url);
    expect(stillThere).toBe(true);
  });
});
