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
    await createScriptInjector({ port: browser.port }).apply(config);

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
    await createScriptInjector({ port: browser.port }).apply(config);
    expect(browser.registeredScripts).toHaveLength(1);
    expect(browser.registeredScripts[0]!.runAt).toBe("document_start");
  });

  it("registers nothing when the config has no scripts", async () => {
    const browser = aFakeBrowser();
    const config = parseConfig(`rules:\n  - match: bare.example\n    open: C\n`);
    await createScriptInjector({ port: browser.port }).apply(config);
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
    await createScriptInjector({ port: browser.port }).apply(handBuilt);
    expect(browser.registeredScripts).toEqual([]);
  });
  it("replaces its registrations on the next apply, leaving one per snippet", async () => {
    const browser = aFakeBrowser();
    const injector = createScriptInjector({ port: browser.port });
    const before = parseConfig(`rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`);
    const after = parseConfig(`rules:\n  - match: b.example\n    scripts:\n      - { run: "b();" }\n`);

    await injector.apply(before);
    await injector.apply(after);

    // Asserted as the whole list, not "contains b": an apply that only added would go on
    // injecting a snippet the config no longer names, and the only signal the user gets is
    // a page still being rewritten by a rule they deleted.
    expect(browser.registeredScripts).toEqual([
      { matches: ["*://b.example/*", "*://*.b.example/*"], js: [{ code: "b();" }], runAt: "document_start" },
    ]);
  });

  it("registers a snippet exactly once when the same config is applied twice", async () => {
    const browser = aFakeBrowser();
    const injector = createScriptInjector({ port: browser.port });
    const config = parseConfig(`rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`);

    await injector.apply(config);
    await injector.apply(config);

    expect(browser.registeredScripts).toHaveLength(1);
  });

  it("drops every registration when the new config has no scripts", async () => {
    const browser = aFakeBrowser();
    const injector = createScriptInjector({ port: browser.port });
    await injector.apply(parseConfig(`rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`));

    await injector.apply(parseConfig(`rules:\n  - match: a.example\n    open: A\n`));

    expect(browser.registeredScripts).toEqual([]);
  });
});
