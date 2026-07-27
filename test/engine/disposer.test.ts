import { describe, it, expect } from "vitest";
import { createMockPort, createFakeClock } from "./mock-port";
import { createDisposer } from "../../src/engine/disposer";

const GRACE = 300_000;

function setup() {
  const mp = createMockPort();
  const fc = createFakeClock();
  return { mp, fc };
}

describe("disposer — targeted grace disposal", () => {
  it("removes a tmp container after its last tab closes + grace elapses", async () => {
    const { mp, fc } = setup();
    const tmp = mp.addIdentity({ name: "tmp1" });
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    const tab = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: tmp.cookieStoreId });

    await mp.emitTabRemoved(tab.id);
    await fc.advance(GRACE - 1);
    expect(mp.calls.removeIdentity).toEqual([]); // not yet
    await fc.advance(1);
    expect(mp.calls.removeIdentity).toEqual([tmp.cookieStoreId]);
  });

  it("keep-alive: a tab returning within the grace prevents removal", async () => {
    const { mp, fc } = setup();
    const tmp = mp.addIdentity({ name: "tmp1" });
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    const tab = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: tmp.cookieStoreId });

    await mp.emitTabRemoved(tab.id);
    await fc.advance(GRACE / 2);
    await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: tmp.cookieStoreId }); // reopened
    await fc.advance(GRACE);
    expect(mp.calls.removeIdentity).toEqual([]); // still has a tab
  });

  it("never removes a permanent/user container", async () => {
    const { mp, fc } = setup();
    const work = mp.addIdentity({ name: "Work" });
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    const tab = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: work.cookieStoreId });

    await mp.emitTabRemoved(tab.id);
    await fc.advance(GRACE * 2);
    expect(mp.calls.removeIdentity).toEqual([]);
  });

  it("does not remove while other tabs remain in the container", async () => {
    const { mp, fc } = setup();
    const tmp = mp.addIdentity({ name: "tmp1" });
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    const a = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: tmp.cookieStoreId });
    await mp.emitTabCreated({ url: "https://b.test/", cookieStoreId: tmp.cookieStoreId });

    await mp.emitTabRemoved(a.id);
    await fc.advance(GRACE * 2);
    expect(mp.calls.removeIdentity).toEqual([]); // one tab still there
  });
});
