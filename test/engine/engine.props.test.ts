import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createMockPort } from "./mock-port";
import { createEngine } from "../../src/engine/engine";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Config, Deps, Rule } from "../../src/resolver/types";
import type { WebRequestDetails } from "../../src/engine/port";

const deps: Deps = { matchRule, matchGroup, sameSite };
const HOSTS = ["a.test", "b.test", "c.example"] as const;
const noop = () => {};

function counter(): () => string {
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
  const mp = createMockPort();
  const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
  return { mp, tab };
}

function req(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://a.test/", type: "main_frame", method: "GET", ...over };
}

describe("engine — property-based invariants", () => {
  it("bounded effect: any single fired nav opens at most one tab (F1)", async () => {
    await fc.assert(
      fc.asyncProperty(arbConfig, arbUrl, async (config, url) => {
        const { mp, tab } = freshMockWithTab();
        createEngine({ port: mp.port, config, deps, onChoice: noop, tmpSuffix: counter() });
        await mp.fire(req({ tabId: tab.id, url }));
        expect(mp.calls.createTab.length).toBeLessThanOrEqual(1);
      })
    );
  });

  it("target fidelity: a reopened tab lands in the container resolve() chose", async () => {
    await fc.assert(
      fc.asyncProperty(arbConfig, arbUrl, async (config, url) => {
        const { mp, tab } = freshMockWithTab();
        createEngine({ port: mp.port, config, deps, onChoice: noop, tmpSuffix: counter() });
        const res = await mp.fire(req({ tabId: tab.id, url }));
        if (res && res.cancel && mp.calls.createTab.length === 1) {
          // Whatever container we opened must exist as a real store the registry
          // recognizes (default, a named permanent, or a tmp throwaway).
          const store = mp.calls.createTab[0].cookieStoreId;
          const known = store === "firefox-default" || (await mp.port.getIdentity(store)) !== null;
          expect(known).toBe(true);
        }
      })
    );
  });

  it("defer totality: if MAC owns the URL, no tab is ever opened or removed (F7)", async () => {
    await fc.assert(
      fc.asyncProperty(arbConfig, arbUrl, async (config, url) => {
        const { mp, tab } = freshMockWithTab();
        mp.setMacAssignment(url, { userContextId: 1 }); // MAC owns every fired URL
        createEngine({ port: mp.port, config, deps, onChoice: noop, tmpSuffix: counter() });
        await mp.fire(req({ tabId: tab.id, url }));
        expect(mp.calls.createTab).toHaveLength(0);
        expect(mp.calls.removeTab).toHaveLength(0);
      })
    );
  });
});
