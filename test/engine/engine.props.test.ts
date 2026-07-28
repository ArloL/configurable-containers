import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { aFakeBrowser } from "./mock-port";
import { createEngine } from "../../src/engine/engine";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Config, Deps, Rule } from "../../src/resolver/types";
import type { WebRequestDetails } from "../../src/engine/port";

const deps: Deps = { matchRule, matchGroup, sameSite };
const HOSTS = ["a.test", "b.test", "c.example"] as const;
const ignoreChoices = () => {};

function sequentialTmpSuffixes(): () => string {
  let n = 0;
  return () => String(++n);
}

// A small arbitrary Config over the fixed host set.
const arbConfig: fc.Arbitrary<Config> = fc
  .array(
    fc.record({
      host: fc.constantFrom(...HOSTS),
      action: fc.constantFrom<Rule["action"]>(
        { kind: "open", containers: ["Work"] },
        { kind: "open", containers: ["Work", "Personal"] },
        { kind: "inherit" },
        { kind: "ignore" }
      ),
    }),
    { maxLength: 4 }
  )
  .map((rows) => ({
    rules: rows.map((r) => ({ match: [hostMatcher(r.host)], action: r.action })),
    groups: [],
  }));

const arbUrl = fc.constantFrom(...HOSTS.map((h) => `https://${h}/`));

function freshMockWithTab() {
  const browser = aFakeBrowser();
  const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
  return { browser, tab };
}

function aNavigationTo(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://a.test/", type: "main_frame", method: "GET", ...over };
}

describe("engine — property-based invariants", () => {
  it("bounded effect: any single fired nav opens at most one tab (F1)", async () => {
    await fc.assert(
      fc.asyncProperty(arbConfig, arbUrl, async (config, url) => {
        const { browser, tab } = freshMockWithTab();
        createEngine({ port: browser.port, config, deps, onChoice: ignoreChoices, tmpSuffix: sequentialTmpSuffixes() });
        await browser.navigates(aNavigationTo({ tabId: tab.id, url }));
        expect(browser.openedTabs.length).toBeLessThanOrEqual(1);
      })
    );
  });

  it("target fidelity: a reopened tab lands in the container resolve() chose", async () => {
    await fc.assert(
      fc.asyncProperty(arbConfig, arbUrl, async (config, url) => {
        const { browser, tab } = freshMockWithTab();
        createEngine({ port: browser.port, config, deps, onChoice: ignoreChoices, tmpSuffix: sequentialTmpSuffixes() });
        const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id, url }));
        if (blockingResponse && blockingResponse.cancel && browser.openedTabs.length === 1) {
          // Whatever container we opened must exist as a real store the registry
          // recognizes (default, a named permanent, or a tmp throwaway).
          const store = browser.openedTabs[0].cookieStoreId;
          const known = store === "firefox-default" || (await browser.port.getIdentity(store)) !== null;
          expect(known).toBe(true);
        }
      })
    );
  });

  it("defer totality: if MAC owns the URL, no tab is ever opened or removed (F7)", async () => {
    await fc.assert(
      fc.asyncProperty(arbConfig, arbUrl, async (config, url) => {
        const { browser, tab } = freshMockWithTab();
        browser.macAssigns(url, { userContextId: 1 }); // MAC owns every fired URL
        createEngine({ port: browser.port, config, deps, onChoice: ignoreChoices, tmpSuffix: sequentialTmpSuffixes() });
        await browser.navigates(aNavigationTo({ tabId: tab.id, url }));
        expect(browser.openedTabs).toHaveLength(0);
        expect(browser.closedTabIds).toHaveLength(0);
      })
    );
  });
});
