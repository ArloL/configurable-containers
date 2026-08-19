import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { createRegistry, isThrowawayName, TMP_PREFIX } from "../../src/engine/registry";

function sequentialTmpSuffixes(): () => string {
  let n = 0;
  return () => String(++n);
}

describe("TMP_PREFIX", () => {
  // The literal, said out loud once. Every other case here interpolates the constant, so
  // a rename moves both sides of the assertion and they stay green; the cases that do
  // hardcode "tmp1" (highestTmpSuffix, the engine's reopen expectations) fail for their
  // own reasons and say nothing about why the value matters.
  //
  // It matters because a throwaway is recognised as ours by NAME, and the name is the
  // only record that outlives the background context: a config save calls
  // runtime.reload(), and every in-memory structure dies with it. Renaming the prefix
  // therefore orphans every tmp<N> container already in a live profile — the disposer
  // stops seeing them, so they are never reclaimed, and highestTmpSuffix stops counting
  // them, so the counter reissues from 1 beside containers that already hold that name.
  // Both are silent. This is a compatibility constant, not an implementation detail:
  // change it only with a migration that renames what is already out there.
  it("is 'tmp'", () => {
    expect(TMP_PREFIX).toBe("tmp");
  });

  // The digits are not decoration. The prefix ALONE claims every container a user could
  // reasonably name — `tmpwork`, or `tmpfiles.org` from an auto-named rule for that host
  // — and claiming one is two silent losses: the disposer deletes it once its last tab
  // closes, with the logins in it, and toRef reads a tab in it as already-in-a-throwaway,
  // so routing answers the continuity question about a permanent container.
  it("recognises a throwaway by tmp + digits, and nothing else", () => {
    for (const name of ["tmp1", "tmp42", "tmp0", "tmp1000"]) {
      expect(isThrowawayName(name)).toBe(true);
    }
    for (const name of ["tmp", "tmpwork", "tmpfiles.org", "tmp 1", "tmp1x", "xtmp1", "Tmp1", "tmp-1", "tmp1.5"]) {
      expect(isThrowawayName(name)).toBe(false);
    }
  });

  // Both minting sites build the name as TMP_PREFIX + a decimal counter; if either ever
  // stopped, the container it created would be invisible to the disposer and leak.
  it("recognises the names the registry itself mints", () => {
    expect(isThrowawayName(TMP_PREFIX + "7")).toBe(true);
  });
});

describe("ContainerRegistry.toRef", () => {
  it("firefox-default maps to default (without querying identities)", async () => {
    const browser = aFakeBrowser();
    const reg = createRegistry(browser.port, sequentialTmpSuffixes());
    expect(await reg.toRef("firefox-default")).toEqual({ kind: "default" });
  });

  it("undefined maps to default", async () => {
    const browser = aFakeBrowser();
    const reg = createRegistry(browser.port, sequentialTmpSuffixes());
    expect(await reg.toRef(undefined)).toEqual({ kind: "default" });
  });

  it("a tmp-prefixed container maps to temporary", async () => {
    const browser = aFakeBrowser();
    const container = browser.addContainerNamed({ name: `${TMP_PREFIX}42` });
    const reg = createRegistry(browser.port, sequentialTmpSuffixes());
    expect(await reg.toRef(container.cookieStoreId)).toEqual({ kind: "temporary" });
  });

  it("a normally-named container maps to permanent with that name", async () => {
    const browser = aFakeBrowser();
    const container = browser.addContainerNamed({ name: "Work" });
    const reg = createRegistry(browser.port, sequentialTmpSuffixes());
    expect(await reg.toRef(container.cookieStoreId)).toEqual({ kind: "permanent", name: "Work" });
  });

  it("a tmp-PREFIXED but not tmp-numbered container is permanent, not a throwaway", async () => {
    const browser = aFakeBrowser();
    const container = browser.addContainerNamed({ name: "tmpwork" });
    const reg = createRegistry(browser.port, sequentialTmpSuffixes());
    expect(await reg.toRef(container.cookieStoreId)).toEqual({ kind: "permanent", name: "tmpwork" });
  });

  it("a missing container maps to default", async () => {
    const browser = aFakeBrowser();
    const reg = createRegistry(browser.port, sequentialTmpSuffixes());
    expect(await reg.toRef("firefox-container-999")).toEqual({ kind: "default" });
  });
});

describe("ContainerRegistry.toStoreId", () => {
  it("default maps to firefox-default", async () => {
    const browser = aFakeBrowser();
    const reg = createRegistry(browser.port, sequentialTmpSuffixes());
    expect(await reg.toStoreId({ kind: "default" })).toBe("firefox-default");
  });

  it("permanent finds an existing container by exact name", async () => {
    const browser = aFakeBrowser();
    const container = browser.addContainerNamed({ name: "Work" });
    const reg = createRegistry(browser.port, sequentialTmpSuffixes());
    expect(await reg.toStoreId({ kind: "permanent", name: "Work" })).toBe(container.cookieStoreId);
    expect(browser.createdContainers).toHaveLength(0);
  });

  it("permanent creates a container when none matches, then caches it", async () => {
    const browser = aFakeBrowser();
    const reg = createRegistry(browser.port, sequentialTmpSuffixes());
    const first = await reg.toStoreId({ kind: "permanent", name: "Personal" });
    expect(first).toMatch(/^firefox-container-\d+$/);
    expect(browser.createdContainers).toHaveLength(1);
    const second = await reg.toStoreId({ kind: "permanent", name: "Personal" });
    expect(second).toBe(first);
    expect(browser.createdContainers).toHaveLength(1); // cached, no second create
  });

  it("temporary creates a fresh tmp-prefixed container using the injected suffix", async () => {
    const browser = aFakeBrowser();
    const reg = createRegistry(browser.port, sequentialTmpSuffixes());
    const store = await reg.toStoreId({ kind: "temporary" });
    const container = await browser.port.getIdentity(store);
    expect(container?.name).toBe(`${TMP_PREFIX}1`);
    expect(await reg.toRef(store)).toEqual({ kind: "temporary" });
  });
});
