import { describe, it, expect } from "vitest";
import { aFakeBrowser, aFakeClock } from "./mock-port";
import { createDisposer } from "../../src/engine/disposer";

const GRACE = 300_000;
const GC_INTERVAL_MS = 600_000;

function aBrowserWithFakeClock() {
  const browser = aFakeBrowser();
  const { clock, advance } = aFakeClock();
  return { browser, clock, advance };
}

describe("disposer — targeted grace disposal", () => {
  it("removes a tmp container after its last tab closes + grace elapses", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    const throwaway = browser.addContainerNamed({ name: "tmp1" });
    createDisposer({ port: browser.port, clock, graceMs: GRACE });
    const onlyTabInTheThrowaway = await browser.opensTab({ url: "https://a.test/", cookieStoreId: throwaway.cookieStoreId });
    await advance(0); // let the startup sweep run: tmp1 has a tab -> kept
    expect(browser.removedContainers).toEqual([]);

    await browser.closesTab(onlyTabInTheThrowaway);
    await advance(GRACE - 1);
    expect(browser.removedContainers).toEqual([]); // not yet
    await advance(1);
    expect(browser.removedContainers).toEqual([throwaway.cookieStoreId]);
  });

  it("keep-alive: a tab returning within the grace prevents removal", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    const throwaway = browser.addContainerNamed({ name: "tmp1" });
    createDisposer({ port: browser.port, clock, graceMs: GRACE });
    const onlyTabInTheThrowaway = await browser.opensTab({ url: "https://a.test/", cookieStoreId: throwaway.cookieStoreId });
    await advance(0); // startup

    await browser.closesTab(onlyTabInTheThrowaway);
    await advance(GRACE / 2);
    await browser.opensTab({ url: "https://a.test/", cookieStoreId: throwaway.cookieStoreId }); // reopened
    await advance(GRACE);
    expect(browser.removedContainers).toEqual([]); // still has a tab
  });

  it("never removes a permanent/user container", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    const permanentContainer = browser.addContainerNamed({ name: "Work" });
    createDisposer({ port: browser.port, clock, graceMs: GRACE });
    const onlyTabInTheThrowaway = await browser.opensTab({ url: "https://a.test/", cookieStoreId: permanentContainer.cookieStoreId });
    await advance(0); // startup

    await browser.closesTab(onlyTabInTheThrowaway);
    await advance(GRACE * 2);
    expect(browser.removedContainers).toEqual([]);
  });

  it("does not remove while other tabs remain in the container", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    const throwaway = browser.addContainerNamed({ name: "tmp1" });
    createDisposer({ port: browser.port, clock, graceMs: GRACE });
    const firstTab = await browser.opensTab({ url: "https://a.test/", cookieStoreId: throwaway.cookieStoreId });
    await browser.opensTab({ url: "https://b.test/", cookieStoreId: throwaway.cookieStoreId });
    await advance(0); // startup

    await browser.closesTab(firstTab);
    await advance(GRACE * 2);
    expect(browser.removedContainers).toEqual([]); // one tab still there
  });
});

describe("disposer — GC sweep + startup", () => {
  it("startup sweep removes a pre-existing empty tmp container immediately", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    const throwaway = browser.addContainerNamed({ name: "tmp1" }); // exists, no tabs
    createDisposer({ port: browser.port, clock, graceMs: GRACE });
    await advance(0); // startup sweep uses skipDelay (0ms)
    expect(browser.removedContainers).toEqual([throwaway.cookieStoreId]);
  });

  it("startup sweep leaves a permanent container alone", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    browser.addContainerNamed({ name: "Work" });
    createDisposer({ port: browser.port, clock, graceMs: GRACE });
    await advance(0);
    expect(browser.removedContainers).toEqual([]);
  });

  it("periodic GC removes an orphaned empty tmp container after the interval", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    createDisposer({ port: browser.port, clock, graceMs: GRACE });
    await advance(0); // clear startup sweep (nothing to remove)
    const throwaway = browser.addContainerNamed({ name: "tmp9" }); // appears later, no tab-close event
    await advance(GC_INTERVAL_MS + GRACE);
    expect(browser.removedContainers).toEqual([throwaway.cookieStoreId]);
  });

  it("dedup: after a tab-close removes it, a later GC tick does not remove it again", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    const throwaway = browser.addContainerNamed({ name: "tmp1" });
    createDisposer({ port: browser.port, clock, graceMs: GRACE });
    const onlyTabInTheThrowaway = await browser.opensTab({ url: "https://a.test/", cookieStoreId: throwaway.cookieStoreId });
    await advance(0); // startup: tmp1 has a tab -> kept

    await browser.closesTab(onlyTabInTheThrowaway);
    await advance(GC_INTERVAL_MS + GRACE); // grace fires (removes); a GC tick also elapses
    expect(browser.removedContainers).toEqual([throwaway.cookieStoreId]); // exactly one
  });
});
