import { describe, it, expect } from "vitest";
import { matcherToPatterns } from "../../src/matcher/matcher";
import { scriptsFor, scriptRegistrations } from "../../src/overlays/scripts";
import { matchRule } from "../../src/matcher/matcher";
import { parseConfig } from "../../src/config/parse";
import type { Config } from "../../src/resolver/types";

describe("matcherToPatterns", () => {
  it("converts a host matcher to the two covering patterns", () => {
    expect(matcherToPatterns({ kind: "host", host: "youtube.com" })).toEqual([
      "*://youtube.com/*",
      "*://*.youtube.com/*",
    ]);
  });

  it("patterns for a list of matchers are the union (no dedup required)", () => {
    const p = [
      ...matcherToPatterns({ kind: "host", host: "youtube.com" }),
      ...matcherToPatterns({ kind: "host", host: "youtube.de" }),
    ];
    expect(p).toEqual([
      "*://youtube.com/*", "*://*.youtube.com/*",
      "*://youtube.de/*", "*://*.youtube.de/*",
    ]);
  });
});

const config = parseConfig(`
rules:
  - match: specific.example
    open: A
    scripts:
      - { run: "specific();" }
  - match: pocket.example
    ignore: true
  - match: example
    open: B
    scripts:
      - { at: document_end, run: "broad();" }
      - { run: "broad2();" }
`);

describe("scriptsFor", () => {
  it("returns the matched rule's scripts", () => {
    expect(scriptsFor("https://specific.example/", config, matchRule)).toEqual([
      { run: "specific();" },
    ]);
  });

  it("returns [] when no rule matches", () => {
    expect(scriptsFor("https://nomatch.test/", config, matchRule)).toEqual([]);
  });

  it("returns [] for a matched ignore rule", () => {
    expect(scriptsFor("https://pocket.example/", config, matchRule)).toEqual([]);
  });

  it("returns [] for an ignore rule that defensively carries scripts (parser rejects this)", () => {
    const handBuilt: Config = {
      rules: [
        {
          match: config.rules[1].match,
          action: { kind: "ignore" },
          scripts: [{ run: "ignored();" }],
        },
      ],
      groups: [],
    };
    expect(scriptsFor("https://pocket.example/", handBuilt, matchRule)).toEqual([]);
  });

  it("honours first-match precedence (specific above broad)", () => {
    expect(scriptsFor("https://specific.example/", config, matchRule)).toEqual([
      { run: "specific();" },
    ]);
  });

  it("returns [] for a rule that matches but carries no scripts", () => {
    const c = parseConfig(`rules:\n  - match: bare.example\n    open: C\n`);
    expect(scriptsFor("https://bare.example/", c, matchRule)).toEqual([]);
  });
});

describe("scriptRegistrations", () => {
  it("flattens every rule's scripts into register-arg shape, with match patterns", () => {
    expect(scriptRegistrations(config)).toEqual([
      {
        matches: ["*://specific.example/*", "*://*.specific.example/*"],
        code: "specific();",
        runAt: "document_start",
      },
      {
        matches: ["*://example/*", "*://*.example/*"],
        code: "broad();",
        runAt: "document_end",
      },
      {
        matches: ["*://example/*", "*://*.example/*"],
        code: "broad2();",
        runAt: "document_start",
      },
    ]);
  });

  it("skips an ignore rule that defensively carries scripts (parser rejects this)", () => {
    const handBuilt: Config = {
      rules: [
        {
          match: config.rules[1].match,
          action: { kind: "ignore" },
          scripts: [{ run: "x();" }],
        },
        { match: config.rules[0].match, action: { kind: "open", containers: ["A"] } },
      ],
      groups: [],
    };
    expect(scriptRegistrations(handBuilt)).toEqual([]);
  });

  it("returns [] for a config with no scripts", () => {
    const c = parseConfig(`rules:\n  - match: bare.example\n    open: C\n`);
    expect(scriptRegistrations(c)).toEqual([]);
  });
});
