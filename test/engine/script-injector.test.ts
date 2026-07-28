import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { createScriptInjector } from "../../src/engine/script-injector";
import { parseConfig } from "../../src/config/parse";
import type { Config } from "../../src/resolver/types";

describe("script-injector", () => {
  it("registers each script with the right matches/code/runAt", async () => {
    const browser = aFakeBrowser();
    const config = parseConfig(`
rules:
  - match: work.example
    open: Work
    scripts:
      - { at: document_start, run: "localStorage.setItem('cc_script','1');" }
  - match: two.example
    scripts:
      - { run: "first();" }
      - { at: document_end, run: "second();" }
`);
    await createScriptInjector({ port: browser.port, config });

    expect(browser.registeredScripts).toEqual([
      {
        matches: ["*://work.example/*", "*://*.work.example/*"],
        js: [{ code: "localStorage.setItem('cc_script','1');" }],
        runAt: "document_start",
      },
      {
        matches: ["*://two.example/*", "*://*.two.example/*"],
        js: [{ code: "first();" }],
        runAt: "document_start",
      },
      {
        matches: ["*://two.example/*", "*://*.two.example/*"],
        js: [{ code: "second();" }],
        runAt: "document_end",
      },
    ]);
  });

  it("defaults runAt to document_start when at is omitted", async () => {
    const browser = aFakeBrowser();
    const config = parseConfig(`rules:\n  - match: x.example\n    scripts:\n      - { run: "x();" }\n`);
    await createScriptInjector({ port: browser.port, config });
    expect(browser.registeredScripts).toHaveLength(1);
    expect(browser.registeredScripts[0].runAt).toBe("document_start");
  });

  it("registers nothing when the config has no scripts", async () => {
    const browser = aFakeBrowser();
    const config = parseConfig(`rules:\n  - match: bare.example\n    open: C\n`);
    await createScriptInjector({ port: browser.port, config });
    expect(browser.registeredScripts).toEqual([]);
  });

  it("skips an ignore rule's scripts (defensive — parser already rejects)", async () => {
    const browser = aFakeBrowser();
    // parseConfig REJECTS scripts-on-ignore, so hand-build the Config to test the
    // injector's defensive skip directly.
    const handBuilt: Config = {
      rules: [
        {
          match: [{ kind: "host", host: "ignored.example" }],
          action: { kind: "ignore" },
          scripts: [{ run: "x();" }],
        },
      ],
      groups: [],
    };
    await createScriptInjector({ port: browser.port, config: handBuilt });
    expect(browser.registeredScripts).toEqual([]);
  });
});
