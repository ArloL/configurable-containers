import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/config/parse";

const parse = (yaml: string) => parseConfig(yaml);

describe("parseConfig — scripts overlay", () => {
  it("parses a full script entry into rule.scripts", () => {
    const config = parse(`
rules:
  - match: youtube.com
    open: Temporary
    scripts:
      - at: document_start
        run: "localStorage.setItem('yt', '1');"
`);
    expect(config.rules[0]!.scripts).toEqual([
      { at: "document_start", run: "localStorage.setItem('yt', '1');" },
    ]);
  });

  it("defaults at to document_start when omitted", () => {
    const config = parse(`
rules:
  - match: x.com
    scripts:
      - { run: "document.title = 'hi';" }
`);
    expect(config.rules[0]!.scripts).toEqual([{ run: "document.title = 'hi';" }]);
  });

  it("parses multiple scripts on one rule", () => {
    const config = parse(`
rules:
  - match: x.com
    scripts:
      - { run: "a();" }
      - { at: document_end, run: "b();" }
`);
    expect(config.rules[0]!.scripts).toEqual([
      { run: "a();" },
      { at: "document_end", run: "b();" },
    ]);
  });

  it("leaves scripts undefined when the key is absent", () => {
    const config = parse(`rules:\n  - match: x.com\n`);
    expect(config.rules[0]!.scripts).toBeUndefined();
  });

  it("parses cookies and scripts on the same rule", () => {
    const config = parse(`
rules:
  - match: youtube.com
    open: Temporary
    cookies:
      - { name: wide, url: "https://www.youtube.com/", value: "1" }
    scripts:
      - { at: document_start, run: "localStorage.setItem('wide','1');" }
`);
    expect(config.rules[0]!.cookies).toEqual([
      { name: "wide", url: "https://www.youtube.com/", value: "1" },
    ]);
    expect(config.rules[0]!.scripts).toEqual([
      { at: "document_start", run: "localStorage.setItem('wide','1');" },
    ]);
  });

  it("rejects scripts on an ignore rule", () => {
    expect(() => parse(`
rules:
  - match: getpocket.com
    ignore: true
    scripts:
      - { run: "x();" }
`)).toThrow(/scripts.*not allowed.*ignore/i);
  });

  it("rejects a non-list scripts value", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    scripts: nope\n`)).toThrow(ConfigError);
  });

  it("rejects a script missing run", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    scripts:\n      - { at: document_start }\n`)).toThrow(/\.run is required/);
  });

  it("rejects an empty run", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    scripts:\n      - { run: "" }\n`)).toThrow(/\.run is required/);
  });

  it("rejects unknown keys and wrong-typed fields", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    scripts:\n      - { run: "x();", bogus: 1 }\n`)).toThrow(/unknown key "bogus"/);
    expect(() => parse(`rules:\n  - match: x.com\n    scripts:\n      - { run: 123 }\n`)).toThrow(/\.run must be a string/);
    expect(() => parse(`rules:\n  - match: x.com\n    scripts:\n      - { run: "x();", at: whenever }\n`)).toThrow(/\.at must be one of/);
  });
});
