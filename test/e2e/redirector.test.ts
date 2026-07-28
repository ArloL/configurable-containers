import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, awaitContainerTab, type Session } from "../../harness/firefox";

describe("redirector auto-close (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"], ccRedirectorDelayMs: 200 });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  async function navFreshTab(url: string): Promise<void> {
    // The previous case leaves the driver on a tab CC closed, and newWindow needs a
    // live context ("Browsing context has been discarded") — re-anchor first.
    const handles = await firefox.driver.getAllWindowHandles();
    await firefox.driver.switchTo().window(handles[handles.length - 1]);
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(url);
    } catch {
      // CC may reopen the tab away — expected for non-redirector hosts.
    }
  }

  // Poll window handles until none shows `url` (the tab was closed), or time out.
  async function waitForTabGone(url: string, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const handles = await firefox.driver.getAllWindowHandles();
      let present = false;
      for (const handle of handles) {
        try {
          await firefox.driver.switchTo().window(handle);
          if ((await firefox.driver.getCurrentUrl()).startsWith(url)) {
            present = true;
            break;
          }
        } catch {
          // handle closed mid-loop — skip.
        }
      }
      if (!present) return true; // gone
      await firefox.driver.sleep(100);
    }
    return false;
  }

  it("closes a redirector tab after the delay when it stays on the shim domain", async () => {
    const url = `http://redirect.example:${serverPort}/`;
    await navFreshTab(url);
    // The redirector tab stays in whatever container it opened in (redirector → stay),
    // so it loads normally. After the short delay (200ms) the closer closes it.
    const gone = await waitForTabGone(url, 5000);
    expect(gone).toBe(true);
  });

  it("does NOT close a non-redirector tab after the same delay", async () => {
    const url = `http://work.example:${serverPort}/`;
    await navFreshTab(url);
    // work.example routes to the Work container — awaitContainerTab leaves the driver
    // focused on the reopened Work tab.
    const { name: containerName } = await awaitContainerTab(firefox.driver, url);
    expect(containerName).toBe("Work");
    // Wait well past the redirector delay; the Work tab must survive.
    await firefox.driver.sleep(1000);
    const stillThere = (await firefox.driver.getCurrentUrl()).startsWith(url);
    expect(stillThere).toBe(true);
  });
});
