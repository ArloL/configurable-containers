import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import {
  launch,
  awaitContainerTab,
  listTabs,
  navigateTab,
  type ProbeTab,
  type Session,
} from "../../harness/firefox";

// F14 — an `inherit` host in a tab whose opener is in another container.
//
// `openerTabId` outlives the click that set it, and `supersede` carries it across every
// reopen, so a tab CC routed still points at one in a DIFFERENT container. Reading the
// initiator off the opener therefore sent an `inherit` host back to the container the tab
// had just been reopened out of, and since each reopen makes the source tab the new one's
// opener, the next hop sent it straight back: login tabs alternating forever. Reported for
// a Slack link to portal.azure.com, which the hosts below mirror.
//
// L3 pins the same decision, but the browser owns the fact it turns on: how long Firefox
// keeps `openerTabId`, and whether `tabs.create({ openerTabId })` reproduces that lineage
// through a reopen. The mock keeps it because it was written to — hence the opener
// assertion midway, without which this would pass on a Firefox that had dropped it.
//
// The reported chain runs through the choice screen, which the driver can only operate
// once something else opened it. This is its second half, where the fix lives.
const SSO_CONFIG = `
rules:
  - match: sso.example
    inherit: true
  - match: chat.example
    open: Chat
  - match: portal.example
    open: Portal
`;

describe("inherit — a tab whose opener is in another container (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({
      extensions: ["probe", "cc"],
      configYaml: SSO_CONFIG,
      localDomains: ["chat.example", "portal.example", "sso.example"],
    });
    serverPort = new URL(firefox.serverUrl).port;
  }, 120_000);

  afterAll(async () => {
    await firefox?.close();
  });

  // Poll browser.tabs until one matches. The driver stays parked on the chat tab
  // throughout — it is the command relay, and nothing here navigates it.
  async function awaitTab(match: (t: ProbeTab) => boolean, timeoutMs = 15_000): Promise<ProbeTab> {
    const deadline = Date.now() + timeoutMs;
    let tabs: ProbeTab[] = [];
    while (Date.now() < deadline) {
      tabs = await listTabs(firefox.driver);
      const hit = tabs.find(match);
      if (hit) return hit;
      await firefox.driver.sleep(300);
    }
    throw new Error(
      `no matching tab within ${timeoutMs}ms; saw ${JSON.stringify(
        tabs.map((t) => ({ url: t.url, container: t.container })),
      )}`,
    );
  }

  it("stays in the container it is in, instead of bouncing back to the opener's", async () => {
    const portalUrl = `http://portal.example:${serverPort}/`;
    const chatUrl = `http://chat.example:${serverPort}/?link=${encodeURIComponent(portalUrl)}`;
    const ssoUrl = `http://sso.example:${serverPort}/login`;

    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(chatUrl);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const chat = await awaitContainerTab(firefox.driver, chatUrl);
    expect(chat.name).toBe("Chat");
    const chatTab = (await listTabs(firefox.driver)).find((t) => t.url === chatUrl)!;

    // A real target=_blank click, the way the report starts: Firefox opens a pre-commit
    // tab that inherits Chat and points back at this one, and CC reopens it into Portal
    // — carrying the opener across, because a reopened tab keeps the lineage of the tab
    // it replaced.
    await firefox.driver.findElement(By.id("go")).click();
    const portalTab = await awaitTab((t) => t.url.startsWith(portalUrl));
    expect(portalTab.container).toBe("Portal");
    // The precondition, measured rather than assumed: the tab really is in Portal while
    // still pointing at a tab in Chat. Everything below is only a test while this holds.
    expect(portalTab.openerTabId).toBe(chatTab.id);

    const tabIdsBefore = (await listTabs(firefox.driver)).map((t) => t.id).sort();

    // The SSO hop, from the portal page the way a login redirect does — by tab id,
    // since the driver must stay on the chat tab to keep relaying.
    await navigateTab(firefox.driver, portalTab.id, ssoUrl);

    // Whichever way CC decided, some tab ends up showing the SSO url: this one, having
    // been left alone, or a new one opened in Chat by a reopen the opener asked for.
    const landed = await awaitTab((t) => t.url.startsWith(ssoUrl));
    expect(landed.id).toBe(portalTab.id);
    expect(landed.container).toBe("Portal");
    // And the session it belongs to is the only one open: no tab was bought for it, in
    // Chat or anywhere else.
    expect((await listTabs(firefox.driver)).map((t) => t.id).sort()).toEqual(tabIdsBefore);
  }, 60_000);
});
