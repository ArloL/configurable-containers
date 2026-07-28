import { describe, it, expect } from "vitest";
import { aFakeBrowser, aFakeClock } from "./mock-port";
import { createRedirectorCloser } from "../../src/engine/redirector-closer";
import { parseConfig } from "../../src/config/parse";
import { matchRule } from "../../src/matcher/matcher";
import type { Tab } from "../../src/engine/port";

const DELAY = 2000;

const config = parseConfig(`
rules:
  - match: t.co
    redirector: true
  - match: work.example
    open: Work
`);

function makeTab(over: Partial<Tab> = {}): Tab {
  return { id: 1, url: "https://t.co/abc", cookieStoreId: "firefox-default", index: 0, active: true, ...over };
}

describe("redirector-closer", () => {
  it("closes a redirector tab after the delay if it is still on the shim", async () => {
    const browser = aFakeBrowser();
    const { clock, advance } = aFakeClock();
    const tab = browser.existingTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: browser.port, clock: clock, config, deps: { matchRule }, delayMs: DELAY });

    await browser.updatesTab(tab, { status: "complete" });
    await advance(DELAY - 1);
    expect(browser.closedTabIds).toEqual([]); // not yet
    await advance(1);
    expect(browser.closedTabIds).toEqual([tab.id]); // closed after the delay
  });

  it("does NOT close a tab that navigated onward before the delay", async () => {
    const browser = aFakeBrowser();
    const { clock, advance } = aFakeClock();
    const tab = browser.existingTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: browser.port, clock: clock, config, deps: { matchRule }, delayMs: DELAY });

    await browser.updatesTab(tab, { status: "complete" });
    // Tab navigates onward to work.example (non-redirector) before the delay fires.
    await browser.updatesTab(makeTab({ id: tab.id, url: "https://work.example/" }), { status: "complete" });
    await advance(DELAY * 2);
    expect(browser.closedTabIds).toEqual([]); // never closed — moved on
  });

  it("does NOT close a non-redirector tab", async () => {
    const browser = aFakeBrowser();
    const { clock, advance } = aFakeClock();
    const tab = browser.existingTab({ url: "https://work.example/", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: browser.port, clock: clock, config, deps: { matchRule }, delayMs: DELAY });

    await browser.updatesTab(tab, { status: "complete" });
    await advance(DELAY * 2);
    expect(browser.closedTabIds).toEqual([]); // not a redirector — no timer
  });

  it("does NOT close when the tab is gone before the timer fires", async () => {
    const browser = aFakeBrowser();
    const { clock, advance } = aFakeClock();
    const tab = browser.existingTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: browser.port, clock: clock, config, deps: { matchRule }, delayMs: DELAY });

    await browser.updatesTab(tab, { status: "complete" });
    await browser.port.removeTab(tab.id); // engine reopen closed the tab before the delay
    await advance(DELAY * 2);
    expect(browser.closedTabIds).toEqual([tab.id]); // exactly one — the engine's, not the closer's
  });

  it("ignores loading status", async () => {
    const browser = aFakeBrowser();
    const { clock, advance } = aFakeClock();
    const tab = browser.existingTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: browser.port, clock: clock, config, deps: { matchRule }, delayMs: DELAY });

    await browser.updatesTab(tab, { status: "loading" });
    await advance(DELAY * 2);
    expect(browser.closedTabIds).toEqual([]);
  });

  it("ignores non-http(s) URLs", async () => {
    const browser = aFakeBrowser();
    const { clock, advance } = aFakeClock();
    const tab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: browser.port, clock: clock, config, deps: { matchRule }, delayMs: DELAY });

    await browser.updatesTab(tab, { status: "complete" });
    await advance(DELAY * 2);
    expect(browser.closedTabIds).toEqual([]);
  });

  it("schedules no double-close when complete fires twice on the same redirector tab", async () => {
    const browser = aFakeBrowser();
    const { clock, advance } = aFakeClock();
    const tab = browser.existingTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: browser.port, clock: clock, config, deps: { matchRule }, delayMs: DELAY });

    await browser.updatesTab(tab, { status: "complete" });
    await browser.updatesTab(tab, { status: "complete" }); // reload — second timer
    await advance(DELAY);
    // The first timer to fire closes the tab; the second finds getTab → null and returns.
    expect(browser.closedTabIds).toEqual([tab.id]); // exactly one close
  });
});
