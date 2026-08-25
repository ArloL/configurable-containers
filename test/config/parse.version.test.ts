import { describe, it, expect } from "vitest";
import { CONFIG_VERSION, FEATURE_VERSIONS, parseConfigDetailed } from "../../src/config/parse";

// What a config DEMANDS of the build reading it, and what it CLAIMS to demand. The two
// are separate: `requiredVersion` is derived from the features the document uses, while
// the declared `version:` is a line in the text that a build with fewer features than
// this one relies on to know it is out of date.

describe("requiredVersion", () => {
  it("is 1 for a config using nothing but bare hostnames", () => {
    expect(parseConfigDetailed(`rules:\n  - match: x.com\n`).requiredVersion).toBe(1);
  });

  it("is 2 for a match pattern", () => {
    expect(parseConfigDetailed(`rules:\n  - match: "*://*.x.com/*"\n    open: X\n`).requiredVersion).toBe(2);
  });

  it("is 2 for a regex match", () => {
    expect(parseConfigDetailed(`rules:\n  - match: { regex: "^https://x\\\\.com/" }\n    open: X\n`).requiredVersion).toBe(2);
  });

  it("is 2 for a group written as a match pattern", () => {
    expect(parseConfigDetailed(`groups:\n  - ["*://*.x.com/*", y.com]\n`).requiredVersion).toBe(2);
  });

  it("takes the highest version any one feature needs", () => {
    const yaml = `rules:\n  - match: a.com\n  - match: "*://*.b.com/*"\n    open: B\n  - match: c.com\n`;
    expect(parseConfigDetailed(yaml).requiredVersion).toBe(2);
  });

  it("never exceeds what this build understands", () => {
    const yaml = `rules:\n  - match: "*://*.x.com/*"\n    open: X\n`;
    expect(parseConfigDetailed(yaml).requiredVersion).toBeLessThanOrEqual(CONFIG_VERSION);
  });
});

describe("the declared version", () => {
  it("is 1 when the document says nothing", () => {
    expect(parseConfigDetailed(`rules:\n  - match: x.com\n`).declaredVersion).toBe(1);
  });

  it("is what the document says", () => {
    expect(parseConfigDetailed(`version: 2\nrules:\n  - match: x.com\n`).declaredVersion).toBe(2);
  });

  it("is read even from a version this build does not have", () => {
    expect(parseConfigDetailed(`version: 99\nrules:\n  - match: x.com\n`).declaredVersion).toBe(99);
  });

  it("does not become a rule key", () => {
    expect(parseConfigDetailed(`version: 2\nrules:\n  - match: x.com\n`).config.rules).toHaveLength(1);
  });

  it.each([
    ["a string", `version: "2"\n`],
    ["zero", `version: 0\n`],
    ["negative", `version: -1\n`],
    ["fractional", `version: 1.5\n`],
    ["null", `version: null\n`],
  ])("refuses a version that is %s", (_name, yaml) => {
    expect(() => parseConfigDetailed(yaml)).toThrow(/`version` must be a positive integer/);
  });
});

// An exact inventory, not a bound. Every feature of the grammar is here against the
// version that introduced it, so adding one to the parser without deciding what it costs
// an older build fails HERE, where the decision is one line away.
describe("the feature table", () => {
  it("prices every key and match form", () => {
    expect(FEATURE_VERSIONS).toEqual({
      rule: {
        match: 1, open: 1, default: 1, inherit: 1, ignore: 1, redirector: 1, cookies: 1, scripts: 1,
      },
      cookie: {
        name: 1, url: 1, value: 1, domain: 1, path: 1, secure: 1, httpOnly: 1,
        sameSite: 1, expirationDate: 1, firstPartyDomain: 1, partitionKey: 1,
      },
      script: { at: 1, run: 1 },
      matchMapping: { regex: 2 },
      matchForm: { host: 1, pattern: 2, regex: 2 },
    });
  });

  // The two halves of the marker: a build claims to understand every feature it prices, so
  // a feature priced above CONFIG_VERSION would be one this build both implements and
  // declares itself too old for.
  it("agrees with CONFIG_VERSION", () => {
    const versions = Object.values(FEATURE_VERSIONS).flatMap((table: Record<string, number>) =>
      Object.values(table),
    );
    expect(Math.max(...versions)).toBe(CONFIG_VERSION);
  });
});
