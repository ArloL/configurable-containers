import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/config/parse";

const parse = (yaml: string) => parseConfig(yaml);

describe("parseConfig — cookies overlay", () => {
  it("parses a full cookie entry into rule.cookies", () => {
    const config = parse(`
rules:
  - match: youtube.com
    open: Temporary
    cookies:
      - name: SOCS
        url: "https://www.youtube.com/"
        value: "abc"
        secure: true
        httpOnly: false
        sameSite: lax
        expirationDate: 1893456000
        domain: ".youtube.com"
        path: "/"
        firstPartyDomain: ""
        partitionKey: { topLevelSite: "https://youtube.com" }
`);
    expect(config.rules[0].cookies).toEqual([
      {
        name: "SOCS",
        url: "https://www.youtube.com/",
        value: "abc",
        secure: true,
        httpOnly: false,
        sameSite: "lax",
        expirationDate: 1893456000,
        domain: ".youtube.com",
        path: "/",
        firstPartyDomain: "",
        partitionKey: { topLevelSite: "https://youtube.com" },
      },
    ]);
  });

  it("parses a minimal cookie (name + url only) and multiple entries", () => {
    const config = parse(`
rules:
  - match: youtube.com
    cookies:
      - { name: wide, url: "https://www.youtube.com/" }
      - { name: SOCS, url: "https://www.youtube.com/", value: "x" }
`);
    expect(config.rules[0].cookies).toEqual([
      { name: "wide", url: "https://www.youtube.com/" },
      { name: "SOCS", url: "https://www.youtube.com/", value: "x" },
    ]);
  });

  it("leaves cookies undefined when the key is absent", () => {
    const config = parse(`rules:\n  - match: youtube.com\n`);
    expect(config.rules[0].cookies).toBeUndefined();
  });

  it("rejects cookies on an ignore rule", () => {
    expect(() => parse(`
rules:
  - match: getpocket.com
    ignore: true
    cookies:
      - { name: a, url: "https://getpocket.com/" }
`)).toThrow(/cookies.*not allowed.*ignore/i);
  });

  it("rejects a non-list cookies value", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    cookies: nope\n`)).toThrow(ConfigError);
  });

  it("rejects a cookie missing name or url", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { url: "https://x.com/" }\n`)).toThrow(/\.name is required/);
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { name: a }\n`)).toThrow(/\.url is required/);
  });

  it("rejects unknown keys and wrong-typed fields", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { name: a, url: "https://x.com/", bogus: 1 }\n`)).toThrow(/unknown key "bogus"/);
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { name: a, url: "https://x.com/", secure: "yes" }\n`)).toThrow(/secure must be a boolean/);
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { name: a, url: "https://x.com/", sameSite: whenever }\n`)).toThrow(/sameSite must be one of/);
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { name: a, url: "https://x.com/", expirationDate: soon }\n`)).toThrow(/expirationDate must be a number/);
  });
});
