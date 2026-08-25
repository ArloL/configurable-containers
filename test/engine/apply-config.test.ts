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
