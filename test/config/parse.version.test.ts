import { describe, it, expect } from "vitest";
import { CONFIG_VERSION, FEATURE_VERSIONS, parseConfigDetailed } from "../../src/config/parse";
import { regexMatcher } from "../../src/matcher/matcher";

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

// What a build does with a config from a version it has never heard of. The whole point of
// the marker: an unknown key in a config that declares no future version is a typo and stays
// an error, while the same key under `version: 3` is a feature this build predates.
describe("a config from the future", () => {
  const future = (body: string) => parseConfigDetailed(`version: 3\n${body}`);

  it("ignores an unknown rule key and keeps the rest of the rule", () => {
    const parsed = future(`rules:\n  - match: x.com\n    open: X\n    sandbox: true\n`);
    expect(parsed.config.rules[0]!.action).toEqual({ kind: "open", containers: ["X"] });
  });

  it("says which key it ignored, and where", () => {
    const [warning, ...rest] = future(`rules:\n  - match: x.com\n    open: X\n    sandbox: true\n`).warnings;
    expect(rest).toEqual([]);
    expect(warning!.path).toBe("rules[0]");
    expect(warning!.message).toContain('unknown key "sandbox" in rules[0]');
    expect(warning!.message).toContain("version 3");
    expect(warning!.message).toContain(`understands ${CONFIG_VERSION}`);
  });

  it("ignores an unknown cookie key", () => {
    const yaml = `rules:\n  - match: x.com\n    cookies:\n      - { name: a, url: "https://x.com/", chilled: true }\n`;
    expect(future(yaml).config.rules[0]!.cookies).toEqual([{ name: "a", url: "https://x.com/" }]);
  });

  it("ignores an unknown script key", () => {
    const yaml = `rules:\n  - match: x.com\n    scripts:\n      - { run: "x();", world: MAIN }\n`;
    expect(future(yaml).config.rules[0]!.scripts).toEqual([{ run: "x();" }]);
  });

  it("ignores an unknown key inside a match mapping", () => {
    const yaml = `rules:\n  - match: { regex: "^https://x\\\\.com/", flags: i }\n    open: X\n`;
    expect(future(yaml).config.rules[0]!.match).toEqual([regexMatcher("^https://x\\.com/")]);
  });

  // An ignored key can leave a rule meaning something else — an action key this build does
  // not know drops the rule to auto-naming. That is the ordinary action-less semantic, not
  // an invention, and it applies the rule's intent rather than dropping the site.
  it("falls back to auto-naming when the ignored key was the action", () => {
    const parsed = future(`rules:\n  - match: x.com\n    sandbox: true\n`);
    expect(parsed.config.rules[0]!.action).toEqual({ kind: "open", containers: ["x.com"] });
  });

  it("skips a rule it cannot parse at all, and keeps the others", () => {
    const yaml =
      `rules:\n` +
      `  - match: a.com\n` +
      `  - match: b.com\n    open: { name: B }\n` +
      `  - match: c.com\n`;
    const parsed = future(yaml);
    expect(parsed.config.rules.map((r) => r.action)).toEqual([
      { kind: "open", containers: ["a.com"] },
      { kind: "open", containers: ["c.com"] },
    ]);
  });

  it("names a skipped rule by its position in the document", () => {
    const yaml = `rules:\n  - match: a.com\n  - match: b.com\n    open: { name: B }\n`;
    const [warning] = future(yaml).warnings;
    expect(warning!.path).toBe("rules[1]");
    expect(warning!.message).toContain("rules[1] skipped");
    expect(warning!.message).toContain("must be a string or a list of strings");
  });

  it("skips a group it cannot parse", () => {
    const parsed = future(`groups:\n  - [a.com, b.com]\n  - "not a list"\n`);
    expect(parsed.config.groups).toHaveLength(1);
    expect(parsed.warnings[0]!.message).toContain("groups[1] skipped");
  });

  // Leniency is per rule, not per document. Nothing can recover a document whose shape is
  // wrong, and pretending otherwise would run an empty config in silence.
  it("still refuses a document it cannot read at all", () => {
    expect(() => future(`rules: 5\n`)).toThrow(/`rules` must be a list/);
  });
});

describe("a config from this version", () => {
  it("still refuses an unknown key when the document declares nothing", () => {
    expect(() => parseConfigDetailed(`rules:\n  - match: x.com\n    opne: X\n`)).toThrow(/unknown key "opne"/);
  });

  it("still refuses an unknown key when the document declares this version", () => {
    const yaml = `version: ${CONFIG_VERSION}\nrules:\n  - match: x.com\n    opne: X\n`;
    expect(() => parseConfigDetailed(yaml)).toThrow(/unknown key "opne"/);
  });

  it("still refuses a rule it cannot parse", () => {
    expect(() => parseConfigDetailed(`rules:\n  - match: x.com\n    open: { name: X }\n`)).toThrow(
      /must be a string or a list of strings/,
    );
  });
});
