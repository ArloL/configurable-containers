import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/config/parse";
import { hostMatcher as hm } from "../../src/matcher/matcher";

describe("parseConfig — rule forms", () => {
  it("auto-names a bare single-host rule", () => {
    const c = parseConfig(`rules:\n  - match: adventofcode.com\n`);
    expect(c).toEqual({
      rules: [{ match: [hm("adventofcode.com")], action: { kind: "open", containers: ["adventofcode.com"] } }],
      groups: [],
    });
  });

  it("auto-names a multi-host rule after the first host", () => {
    const c = parseConfig(`rules:\n  - match: [notion.com, notion.so]\n`);
    expect(c.rules[0]).toEqual({
      match: [hm("notion.com"), hm("notion.so")],
      action: { kind: "open", containers: ["notion.com"] },
    });
  });

  it("auto-names from the canonical host, not the raw string", () => {
    const c = parseConfig(`rules:\n  - match: Notion.COM\n`);
    expect(c.rules[0].action).toEqual({ kind: "open", containers: ["notion.com"] });
  });

  it("parses open single / multi / default and Temporary passthrough", () => {
    const c = parseConfig(
      `rules:\n` +
        `  - match: goflink.com\n    open: Flink\n` +
        `  - match: figma.com\n    open: [Personal, Work]\n` +
        `  - match: trello.com\n    open: [Personal, Work]\n    default: Work\n` +
        `  - match: pinterest.com\n    open: Temporary\n`,
    );
    expect(c.rules[0].action).toEqual({ kind: "open", containers: ["Flink"] });
    expect(c.rules[1].action).toEqual({ kind: "open", containers: ["Personal", "Work"] });
    expect(c.rules[2].action).toEqual({ kind: "open", containers: ["Personal", "Work"], default: "Work" });
    expect(c.rules[3].action).toEqual({ kind: "open", containers: ["Temporary"] });
  });

  it("parses inherit / ignore / redirector", () => {
    const c = parseConfig(
      `rules:\n` +
        `  - match: accounts.google.com\n    inherit: true\n` +
        `  - match: getpocket.com\n    ignore: true\n` +
        `  - match: [t.co, slack-redir.net]\n    redirector: true\n`,
    );
    expect(c.rules[0].action).toEqual({ kind: "inherit" });
    expect(c.rules[1].action).toEqual({ kind: "ignore" });
    expect(c.rules[2].action).toEqual({ kind: "redirector" });
    expect(c.rules[2].match).toEqual([hm("t.co"), hm("slack-redir.net")]);
  });

  it("tolerates cookies/scripts overlays without surfacing them", () => {
    const c = parseConfig(
      `rules:\n  - match: youtube.com\n    open: Temporary\n` +
        `    cookies:\n      - { name: wide, url: "https://www.youtube.com/", value: "1" }\n`,
    );
    expect(c.rules[0]).toEqual({ match: [hm("youtube.com")], action: { kind: "open", containers: ["Temporary"] } });
  });

  it("returns empty config for empty / comment-only input", () => {
    expect(parseConfig("")).toEqual({ rules: [], groups: [] });
    expect(parseConfig("# just a comment\n")).toEqual({ rules: [], groups: [] });
  });
});

describe("parseConfig — rule validation", () => {
  function err(yaml: string): ConfigError {
    try {
      parseConfig(yaml);
    } catch (e) {
      return e as ConfigError;
    }
    throw new Error("expected parseConfig to throw");
  }

  it("rejects two actions", () => {
    const e = err(`rules:\n  - match: x.com\n    open: X\n    inherit: true\n`);
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).toMatch(/at most one action/);
    expect(e.path).toBe("rules[0]");
  });

  it("rejects default without a multi-value open", () => {
    expect(err(`rules:\n  - match: x.com\n    open: X\n    default: X\n`).path).toBe("rules[0].default");
    expect(err(`rules:\n  - match: x.com\n    inherit: true\n    default: X\n`).path).toBe("rules[0].default");
  });

  it("rejects default not in the open list", () => {
    const e = err(`rules:\n  - match: x.com\n    open: [A, B]\n    default: C\n`);
    expect(e.message).toMatch(/not one of open/);
    expect(e.path).toBe("rules[0].default");
  });

  it("rejects an unknown key", () => {
    expect(err(`rules:\n  - match: x.com\n    opne: X\n`).message).toMatch(/unknown key "opne"/);
  });

  it("rejects a missing match", () => {
    expect(err(`rules:\n  - open: X\n`).message).toMatch(/missing "match"/);
  });

  it("rejects a match pattern / regex (bare hosts only)", () => {
    expect(err(`rules:\n  - match: "https://app.example.com/x/*"\n`).message).toMatch(/not a bare hostname|bare hostnames only/);
    expect(err(`rules:\n  - match:\n      regex: "^https://x/"\n`).message).toMatch(/regex/);
  });

  it("rejects a bare glob match entry (no scheme/slash)", () => {
    for (const host of ["*.example.com", "ex?mple.com", "[abc].com"]) {
      const e = err(`rules:\n  - match: "${host}"\n`);
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.message).toMatch(/not a bare hostname|bare hostnames only/);
    }
  });

  it("rejects an empty match list", () => {
    const e = err(`rules:\n  - match: []\n`);
    expect(e.message).toMatch(/must not be empty/);
    expect(e.path).toBe("rules[0].match");
  });

  it("rejects an empty open list", () => {
    const e = err(`rules:\n  - match: x.com\n    open: []\n`);
    expect(e.message).toMatch(/must not be empty/);
    expect(e.path).toBe("rules[0].open");
  });

  it("rejects an empty container name in open", () => {
    expect(err(`rules:\n  - match: x.com\n    open: ""\n`).path).toBe("rules[0].open");
    expect(err(`rules:\n  - match: x.com\n    open: ["", Work]\n`).path).toBe("rules[0].open[0]");
  });

  it("reports a YAML syntax error with a line number", () => {
    const e = err(`key: 'unterminated string\n`);
    expect(e).toBeInstanceOf(ConfigError);
    expect(typeof e.line).toBe("number");
  });

  it("rejects a non-mapping top level", () => {
    expect(err(`- just\n- a list\n`).message).toMatch(/must be a mapping/);
  });

  it("rejects rules that is not a list", () => {
    expect(err(`rules: nope\n`).path).toBe("rules");
  });
});
