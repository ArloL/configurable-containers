import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import { createAutoTemp } from "../../src/engine/auto-temp";

function setup() {
  const mp = createMockPort();
  return { mp };
}

// Let async init (startup sweep) settle and return control to caller.
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("auto-temp — startup sweep", () => {
  it("containerizes a pre-existing about:newtab at startup", async () => {
    const { mp } = setup();
    mp.addTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    createAutoTemp({ port: mp.port });
    await flush();

    expect(mp.calls.createIdentity).toHaveLength(1);
    expect(mp.calls.createTab).toHaveLength(1);
    expect(mp.calls.createTab[0].url).toBeUndefined(); // Firefox rejects an explicit about:newtab
    expect(mp.calls.removeTab).toHaveLength(1);
  });

  it("does not containerize a pre-existing http tab", async () => {
    const { mp } = setup();
    mp.addTab({ url: "https://example.com/", cookieStoreId: "firefox-default" });
    createAutoTemp({ port: mp.port });
    await flush();

    expect(mp.calls.createIdentity).toHaveLength(0);
  });

  it("does not containerize a pre-existing tab already in a container", async () => {
    const { mp } = setup();
    const tmp = mp.addIdentity({ name: "tmp1" });
    mp.addTab({ url: "about:newtab", cookieStoreId: tmp.cookieStoreId });
    createAutoTemp({ port: mp.port });
    await flush();

    expect(mp.calls.createIdentity).toHaveLength(0);
  });
});

describe("auto-temp — onCreated path", () => {
  it("reopens about:newtab into a fresh temporary container", async () => {
    const { mp } = setup();
    createAutoTemp({ port: mp.port });

    await mp.emitTabCreated({ url: "about:newtab", cookieStoreId: "firefox-default", index: 2, active: true });

    expect(mp.calls.createIdentity).toHaveLength(1);
    const ciName = mp.calls.createIdentity[0].name;
    expect(ciName).toMatch(/^tmp/);
    expect(mp.calls.createTab).toHaveLength(1);
    // No url: the replacement tab gets the browser's new-tab page (see auto-temp.ts).
    expect(mp.calls.createTab[0]).toMatchObject({ index: 2, active: true });
    expect(mp.calls.createTab[0].url).toBeUndefined();
    expect(mp.calls.removeTab).toHaveLength(1);
  });

  it("reopens about:home into a fresh temporary container", async () => {
    const { mp } = setup();
    createAutoTemp({ port: mp.port });

    await mp.emitTabCreated({ url: "about:home", cookieStoreId: "firefox-default" });

    expect(mp.calls.createIdentity).toHaveLength(1);
    expect(mp.calls.createTab).toHaveLength(1);
    expect(mp.calls.createTab[0].url).toBeUndefined(); // Firefox rejects an explicit about:home
    expect(mp.calls.removeTab).toHaveLength(1);
  });

  it("skips tabs already in a non-default container", async () => {
    const { mp } = setup();
    const tmp = mp.addIdentity({ name: "tmp1" });
    createAutoTemp({ port: mp.port });

    await mp.emitTabCreated({ url: "about:newtab", cookieStoreId: tmp.cookieStoreId });

    expect(mp.calls.createIdentity).toHaveLength(0);
    expect(mp.calls.createTab).toHaveLength(0);
    expect(mp.calls.removeTab).toHaveLength(0);
  });

  it("skips http(s) navigations", async () => {
    const { mp } = setup();
    createAutoTemp({ port: mp.port });

    await mp.emitTabCreated({ url: "https://example.com/", cookieStoreId: "firefox-default" });

    expect(mp.calls.createIdentity).toHaveLength(0);
  });

  // about:blank is what a tab reads as until its navigation commits, so it cannot be
  // told apart from a tab on its way to a real page. See auto-temp.ts.
  it("skips about:blank tabs (indistinguishable from a tab mid-load)", async () => {
    const { mp } = setup();
    createAutoTemp({ port: mp.port });

    await mp.emitTabCreated({ url: "about:blank", cookieStoreId: "firefox-default" });

    expect(mp.calls.createIdentity).toHaveLength(0);
  });

  it("guard: creating flag prevents recursive re-containerization of replacement tab", async () => {
    const { mp } = setup();
    createAutoTemp({ port: mp.port });

    await mp.emitTabCreated({ url: "about:newtab", cookieStoreId: "firefox-default" });

    expect(mp.calls.createIdentity).toHaveLength(1);
    expect(mp.calls.createTab).toHaveLength(1);
    expect(mp.calls.removeTab).toHaveLength(1);
  });

  it("preserves openerTabId across the reopen", async () => {
    const { mp } = setup();
    createAutoTemp({ port: mp.port });

    await mp.emitTabCreated({ url: "about:newtab", cookieStoreId: "firefox-default", openerTabId: 99 });

    expect(mp.calls.createTab).toHaveLength(1);
    expect(mp.calls.createTab[0].openerTabId).toBe(99);
  });

  it("uses a shared suffix when provided", async () => {
    const { mp } = setup();
    const suffixes: string[] = [];
    const suffix = () => { const s = `s${suffixes.length + 1}`; suffixes.push(s); return s; };
    createAutoTemp({ port: mp.port, tmpSuffix: suffix });

    await mp.emitTabCreated({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(mp.calls.createIdentity[0].name).toBe("tmps1");

    await mp.emitTabCreated({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(mp.calls.createIdentity[1].name).toBe("tmps2");
  });

  it("handles createIdentity failure gracefully and resets creating flag", async () => {
    const { mp } = setup();
    createAutoTemp({ port: mp.port });

    await mp.emitTabCreated({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(mp.calls.createIdentity).toHaveLength(1);

    await mp.emitTabCreated({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(mp.calls.createIdentity).toHaveLength(2);
  });
});

describe("auto-temp — onTabUpdated fallback path", () => {
  it("containerizes when onUpdated fires about:newtab after onCreated with about:blank", async () => {
    const { mp } = setup();
    createAutoTemp({ port: mp.port });

    const tab = await mp.emitTabCreated({ url: "about:blank", cookieStoreId: "firefox-default" });
    expect(mp.calls.createIdentity).toHaveLength(0);

    await mp.emitTabUpdated(
      { ...tab, url: "about:newtab" },
      { status: "loading" },
    );

    expect(mp.calls.createIdentity).toHaveLength(1);
    expect(mp.calls.createTab).toHaveLength(1);
    expect(mp.calls.createTab[0].url).toBeUndefined(); // Firefox rejects an explicit about:newtab
    expect(mp.calls.removeTab).toHaveLength(1);
  });

  it("deduplicates: processed set prevents double-containerization from both events", async () => {
    const { mp } = setup();
    createAutoTemp({ port: mp.port });

    const tab = await mp.emitTabCreated({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(mp.calls.createIdentity).toHaveLength(1);

    await mp.emitTabUpdated(
      { ...tab, url: "about:newtab" },
      { status: "loading" },
    );

    expect(mp.calls.createIdentity).toHaveLength(1);
    expect(mp.calls.createTab).toHaveLength(1);
  });

  it("skips processed tabs even when creating flag is false", async () => {
    const { mp } = setup();
    createAutoTemp({ port: mp.port });

    const tab = await mp.emitTabCreated({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(mp.calls.createIdentity).toHaveLength(1);

    await mp.emitTabUpdated(
      { ...tab, url: "about:home" },
      { status: "loading" },
    );
    expect(mp.calls.createIdentity).toHaveLength(1);
  });
});
