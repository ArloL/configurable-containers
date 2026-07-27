import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import { createPicker } from "../../src/engine/picker";
import { decodePayload } from "../../src/extension/picker-protocol";
import { parseConfig } from "../../src/config/parse";
import { matchRule, matchGroup } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Tab } from "../../src/engine/port";
import type { Target } from "../../src/resolver/types";

const deps = { matchRule, matchGroup, sameSite };
const config = parseConfig(`
rules:
  - match: figma.example
    open: [Personal, Work]
  - match: youtube.example
    open: [Temporary, Personal]
    default: Temporary
  - match: work.example
    open: Work
`);

function fakeReopen(): {
  reopen: (tab: Tab, url: string, t: Target) => Promise<void>;
  calls: Array<{ tabId: number; url: string; target: Target }>;
} {
  const calls: Array<{ tabId: number; url: string; target: Target }> = [];
  return {
    reopen: async (tab, url, target) => {
      calls.push({ tabId: tab.id, url, target });
    },
    calls,
  };
}

function decodeChoiceUrl(url: string) {
  return decodePayload(url.split("#")[1]);
}

describe("picker — choice screen (onChoice flow)", () => {
  it("showChoice navigates the triggering tab to the choice page with the encoded payload", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://figma.example/", cookieStoreId: "firefox-default" });
    const fr = fakeReopen();
    const picker = createPicker({ port: mp.port, config, deps, reopen: fr.reopen });
    await picker.showChoice(tab.id, "https://figma.example/", ["Personal", "Work"]);

    expect(mp.calls.updates).toHaveLength(1);
    expect(mp.calls.updates[0].tabId).toBe(tab.id);
    expect(mp.calls.updates[0].url).toContain("moz-extension://test/choice.html#");
    expect(decodeChoiceUrl(mp.calls.updates[0].url)).toEqual({
      tabId: tab.id,
      url: "https://figma.example/",
      options: ["Personal", "Work"],
    });
  });

  it("onMessage cc-pick reopens into the chosen permanent container and returns {ok:true}", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://figma.example/", cookieStoreId: "firefox-default", index: 2, active: true });
    const fr = fakeReopen();
    createPicker({ port: mp.port, config, deps, reopen: fr.reopen });

    const res = await mp.emitMessage({ type: "cc-pick", tabId: tab.id, url: "https://figma.example/", container: "Work" });

    expect(res).toEqual({ ok: true });
    expect(fr.calls).toEqual([{ tabId: tab.id, url: "https://figma.example/", target: { kind: "permanent", name: "Work" } }]);
  });

  it("onMessage cc-pick maps 'Temporary' to a {kind:'temporary'} target", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://youtube.example/", cookieStoreId: "firefox-default" });
    const fr = fakeReopen();
    createPicker({ port: mp.port, config, deps, reopen: fr.reopen });

    await mp.emitMessage({ type: "cc-pick", tabId: tab.id, url: "https://youtube.example/", container: "Temporary" });

    expect(fr.calls[0].target).toEqual({ kind: "temporary" });
  });

  it("onMessage returns {ok:false} when reopen throws (fail-open signal to the page)", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://figma.example/", cookieStoreId: "firefox-default" });
    const fr = fakeReopen();
    fr.reopen = async () => {
      throw new Error("boom");
    };
    createPicker({ port: mp.port, config, deps, reopen: fr.reopen });

    const res = await mp.emitMessage({ type: "cc-pick", tabId: tab.id, url: "https://figma.example/", container: "Work" });

    expect(res).toEqual({ ok: false });
  });

  it("onMessage returns {ok:false} when the tab has raced away (getTab null)", async () => {
    const mp = createMockPort();
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });

    const res = await mp.emitMessage({ type: "cc-pick", tabId: 999, url: "https://figma.example/", container: "Work" });

    expect(res).toEqual({ ok: false });
  });

  it("onMessage ignores unrelated messages (returns undefined)", async () => {
    const mp = createMockPort();
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });
    const res = await mp.emitMessage({ type: "something-else" });
    expect(res).toBeUndefined();
  });
});

describe("picker — reopen picker (command flow)", () => {
  it("onCommand reopen-picker shows the choice page with the active tab's matching rule containers", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "http://figma.example:1234/", cookieStoreId: "firefox-default", active: true });
    mp.setActiveTab(tab);
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });

    await mp.emitCommand("reopen-picker");

    expect(mp.calls.updates).toHaveLength(1);
    expect(mp.calls.updates[0].tabId).toBe(tab.id);
    expect(decodeChoiceUrl(mp.calls.updates[0].url)).toEqual({
      tabId: tab.id,
      url: "http://figma.example:1234/",
      options: ["Personal", "Work"],
    });
  });

  it("onCommand reopen-picker with a single-open rule does nothing (nothing to choose)", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "http://work.example:1234/", cookieStoreId: "firefox-default" });
    mp.setActiveTab(tab);
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });

    await mp.emitCommand("reopen-picker");

    expect(mp.calls.updates).toEqual([]);
  });

  it("onCommand reopen-picker with no matching rule does nothing (undecided unmatched case)", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "http://nomatch.example:1234/", cookieStoreId: "firefox-default" });
    mp.setActiveTab(tab);
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });

    await mp.emitCommand("reopen-picker");

    expect(mp.calls.updates).toEqual([]);
  });

  it("onCommand reopen-picker with no active tab does nothing", async () => {
    const mp = createMockPort();
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });
    await mp.emitCommand("reopen-picker");
    expect(mp.calls.updates).toEqual([]);
  });

  it("onCommand ignores an unknown command name", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "http://figma.example:1234/", cookieStoreId: "firefox-default" });
    mp.setActiveTab(tab);
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });
    await mp.emitCommand("something-else");
    expect(mp.calls.updates).toEqual([]);
  });
});
