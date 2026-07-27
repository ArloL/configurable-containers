import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import { createRegistry, TMP_PREFIX } from "../../src/engine/registry";

function counter(): () => string {
  let n = 0;
  return () => String(++n);
}

describe("ContainerRegistry.toRef", () => {
  it("firefox-default maps to default (without querying identities)", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toRef("firefox-default")).toEqual({ kind: "default" });
  });

  it("undefined maps to default", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toRef(undefined)).toEqual({ kind: "default" });
  });

  it("a tmp-prefixed container maps to temporary", async () => {
    const mp = createMockPort();
    const ci = mp.addIdentity({ name: `${TMP_PREFIX}42` });
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toRef(ci.cookieStoreId)).toEqual({ kind: "temporary" });
  });

  it("a normally-named container maps to permanent with that name", async () => {
    const mp = createMockPort();
    const ci = mp.addIdentity({ name: "Work" });
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toRef(ci.cookieStoreId)).toEqual({ kind: "permanent", name: "Work" });
  });

  it("a missing container maps to default", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toRef("firefox-container-999")).toEqual({ kind: "default" });
  });
});

describe("ContainerRegistry.toStoreId", () => {
  it("default maps to firefox-default", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toStoreId({ kind: "default" })).toBe("firefox-default");
  });

  it("permanent finds an existing container by exact name", async () => {
    const mp = createMockPort();
    const ci = mp.addIdentity({ name: "Work" });
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toStoreId({ kind: "permanent", name: "Work" })).toBe(ci.cookieStoreId);
    expect(mp.calls.createIdentity).toHaveLength(0);
  });

  it("permanent creates a container when none matches, then caches it", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    const first = await reg.toStoreId({ kind: "permanent", name: "Personal" });
    expect(first).toMatch(/^firefox-container-\d+$/);
    expect(mp.calls.createIdentity).toHaveLength(1);
    const second = await reg.toStoreId({ kind: "permanent", name: "Personal" });
    expect(second).toBe(first);
    expect(mp.calls.createIdentity).toHaveLength(1); // cached, no second create
  });

  it("temporary creates a fresh tmp-prefixed container using the injected suffix", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    const store = await reg.toStoreId({ kind: "temporary" });
    const ci = await mp.port.getIdentity(store);
    expect(ci?.name).toBe(`${TMP_PREFIX}1`);
    expect(await reg.toRef(store)).toEqual({ kind: "temporary" });
  });
});
