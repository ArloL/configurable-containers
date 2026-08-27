import { describe, it, expect } from "vitest";
import { aFakeBrowser, type MockPort } from "./mock-port";
import { startTheBackground } from "./restart";
import { parseConfig } from "../../src/config/parse";
import { CONFIG_STORAGE_KEY } from "../../src/extension/config";
import { CONFIG_APPLY } from "../../src/extension/config-protocol";
import type { Clock, Tab, WebRequestDetails } from "../../src/engine/port";

const WORK_YAML = `rules:\n  - match: work.example\n    open: Work\n`;
const EDITOR_YAML = `rules:\n  - match: nomatch.example\n    open: Editor\n`;

function aFakeClock(): Clock {
  return { setTimeout: () => {}, now: () => 0 };
}

function aNavigationTo(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://example.com/", type: "main_frame", method: "GET", ...over };
}

// A fresh pre-commit tab per navigation, as a real click on a link in a new tab gives.
async function containerForNavigationTo(browser: MockPort, url: string, requestId: string): Promise<string> {
  const tab: Tab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
  await browser.navigates(aNavigationTo({ tabId: tab.id, url, requestId }));
  const created = browser.openedTabs.at(-1)!;
  const identities = await browser.port.queryIdentities();
  return identities.find((c) => c.cookieStoreId === created.cookieStoreId)!.name;
}

// Saving used to be runtime.reload(): a fresh background read storage on the way up, and
// every sibling saw the new config because nothing of the old one was left to disagree. The
// apply keeps the background alive, so what these cases pin is that the ONE config object
// every sibling reads at event time is the object the apply writes into — and that the
// registrations, the only thing read eagerly, are replaced rather than added to.
describe("applying a stored config without a restart", () => {
  it("routes by the config that was stored, not the one the session started with", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), parseConfig(WORK_YAML));
    await browser.port.writeStored(CONFIG_STORAGE_KEY, EDITOR_YAML);

    expect(await browser.receivesMessage({ type: CONFIG_APPLY })).toEqual({});

    expect(await containerForNavigationTo(browser, "https://nomatch.example/", "a")).toBe("Editor");
  });

  it("stops routing by a rule the stored config no longer has", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), parseConfig(WORK_YAML));
    await browser.port.writeStored(CONFIG_STORAGE_KEY, EDITOR_YAML);
    await browser.receivesMessage({ type: CONFIG_APPLY });

    // Unmatched now, so the disposable path takes it: a throwaway, never the container the
    // deleted rule named.
    expect(await containerForNavigationTo(browser, "https://work.example/", "b")).toMatch(/^tmp/);
  });

  it("replaces the content-script registrations rather than adding to them", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(
      browser,
      aFakeClock(),
      parseConfig(`rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`),
    );
    await browser.port.writeStored(
      CONFIG_STORAGE_KEY,
      `rules:\n  - match: b.example\n    scripts:\n      - { run: "b();" }\n`,
    );

    await browser.receivesMessage({ type: CONFIG_APPLY });

    // The whole list, not "contains b": a snippet the config no longer names would go on
    // being injected into every matching page, and deleting the rule is the only way the
    // user has to stop it.
    expect(browser.registeredScripts.map((s) => s.js[0]!.code)).toEqual(["b();"]);
  });

  it("keeps the new routing and names the failure when a snippet cannot be registered", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), parseConfig(WORK_YAML));
    await browser.port.writeStored(
      CONFIG_STORAGE_KEY,
      `rules:\n  - match: nomatch.example\n    open: Editor\n    scripts:\n      - { run: "x();" }\n`,
    );
    browser.scriptRegistrationFails("no matching host permission");

    expect(await browser.receivesMessage({ type: CONFIG_APPLY })).toEqual({
      scriptError: "no matching host permission",
    });

    // Swap first, register second: the config the user saved is what routes, and the half
    // that failed is reported rather than rolled back into a disagreement with storage.
    expect(await containerForNavigationTo(browser, "https://nomatch.example/", "c")).toBe("Editor");
  });

  it("reports a registration failure that arrives as something other than an Error", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), parseConfig(WORK_YAML));
    await browser.port.writeStored(
      CONFIG_STORAGE_KEY,
      `rules:\n  - match: nomatch.example\n    open: Editor\n    scripts:\n      - { run: "x();" }\n`,
    );
    browser.scriptRegistrationFails({ message: "no matching host permission" });

    // The editor prints whatever comes back, so reading `.message` off a rejection that is
    // not an Error would throw inside the handler and the save would answer nothing at all.
    expect(await browser.receivesMessage({ type: CONFIG_APPLY })).toEqual({
      scriptError: "[object Object]",
    });
  });

  it("applies what is in storage when there is nothing in storage", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), parseConfig(WORK_YAML));

    // Reachable through config-sync's adopt, and through an editor tab left open across a
    // storage the user cleared. The seed is deliberately NOT the fallback here: by the time
    // anything applies, storage is the truth, and a build's seed reappearing would be a
    // second answer to what the config is — silently reinstating rules the user deleted.
    expect(await browser.receivesMessage({ type: CONFIG_APPLY })).toEqual({});
    expect(await containerForNavigationTo(browser, "https://work.example/", "e")).toMatch(/^tmp/);
  });

  it("applies the empty config and names the error when the stored text does not parse", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), parseConfig(WORK_YAML));
    await browser.port.writeStored(CONFIG_STORAGE_KEY, "rules:\n  - match: 123\n    open: Nope\n");

    const reply = (await browser.receivesMessage({ type: CONFIG_APPLY })) as { configError?: string };

    // Loud rather than stale, exactly as startup answers a broken config: everything opens
    // in a throwaway. Only adoption can reach this — the editor refuses to save one.
    expect(reply.configError).toBeTruthy();
    expect(await containerForNavigationTo(browser, "https://work.example/", "d")).toMatch(/^tmp/);
  });

  it("registers each snippet once when two applies overlap", async () => {
    const browser = aFakeBrowser();
    const bg = await startTheBackground(browser, aFakeClock(), parseConfig(WORK_YAML));
    await browser.port.writeStored(
      CONFIG_STORAGE_KEY,
      `rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`,
    );

    // A double-clicked Save, or a Save meeting an adoption. Unserialised, the two unregister
    // each other's nothing and then both register: one snippet, injected twice, for the life
    // of the browser.
    await Promise.all([bg.applyStored(), bg.applyStored()]);

    expect(browser.registeredScripts.map((s) => s.js[0]!.code)).toEqual(["a();"]);
  });

  // The third way two applies overlap, and the one the queue did not cover:
  // `background.ts`'s tail calls `injectScripts()` to register the config it loaded, and a
  // `cc-config-apply` from the editor is a MESSAGE — it does not wait for the tail. The
  // window is small and self-healing, but "every snippet injected twice until the next
  // apply" is not a thing to leave to a comment when the queue already exists.
  //
  // Reachable because a config that does not parse makes startup OPEN the editor, so the
  // page that can send that message is up while the tail is still running.
  it("registers each snippet once when a Save meets the startup injection", async () => {
    const browser = aFakeBrowser();
    const scripted = `rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`;
    const bg = await startTheBackground(browser, aFakeClock(), parseConfig(scripted));
    await browser.port.writeStored(CONFIG_STORAGE_KEY, scripted);

    // The interleaving is STATED rather than inherited. Left to the mock's own timing the
    // two serialise by accident — `applyOnce` awaits `readStored` first, so the injection is
    // always a tick ahead and registers before the apply reaches its unregister — and this
    // case passed with the fix backed out. Firefox makes no such promise: these are IPC
    // round trips. Holding registration open puts both callers past their unregister at the
    // same time, which is the window itself.
    const release = browser.stallScriptRegistration();
    const both = Promise.all([bg.injectScripts(), browser.receivesMessage({ type: CONFIG_APPLY })]);
    await browser.settle();
    release();
    await both;

    expect(browser.registeredScripts.map((s) => s.js[0]!.code)).toEqual(["a();"]);
  });

  // The queue must not be strandable: `injectScripts` deliberately does NOT swallow a
  // registration failure the way `applyOnce` does — the tail is the one caller, and a
  // browser that refuses to register is worth an unhandled rejection there — so a rejected
  // link becomes the head of the chain. The next apply has to run anyway.
  it("keeps applying after a startup injection that failed", async () => {
    const browser = aFakeBrowser();
    const scripted = `rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`;
    const bg = await startTheBackground(browser, aFakeClock(), parseConfig(scripted));
    await browser.port.writeStored(CONFIG_STORAGE_KEY, scripted);

    browser.scriptRegistrationFails("no permission");
    await expect(bg.injectScripts()).rejects.toThrow("no permission");

    browser.scriptRegistrationFails(null);
    expect(await browser.receivesMessage({ type: CONFIG_APPLY })).toEqual({});
    expect(browser.registeredScripts.map((s) => s.js[0]!.code)).toEqual(["a();"]);
  });

  it("publishes to sync after a save, and never after an adoption", async () => {
    const browser = aFakeBrowser();
    const published: string[] = [];
    const bg = await startTheBackground(browser, aFakeClock(), parseConfig(WORK_YAML), {
      afterApply: () => published.push("published"),
    });
    await browser.port.writeStored(CONFIG_STORAGE_KEY, EDITOR_YAML);

    await browser.receivesMessage({ type: CONFIG_APPLY });
    expect(published).toEqual(["published"]);

    // Adoption is already running inside the sync queue a publish goes through, so it takes
    // the apply without the publish. Re-entering that chain would wait on itself.
    await bg.applyStored();
    expect(published).toEqual(["published"]);
  });
});
