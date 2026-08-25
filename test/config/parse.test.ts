import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/config/parse";
import { hostMatcher as hm, matchRule } from "../../src/matcher/matcher";

describe("parseConfig — rule forms", () => {
  it("auto-names a bare single-host rule", () => {
    const parsed = parseConfig(`rules:\n  - match: adventofcode.com\n`);
    expect(parsed).toEqual({
      rules: [{ match: [hm("adventofcode.com")], action: { kind: "open", containers: ["adventofcode.com"] } }],
      groups: [],
    });
  });

  it("auto-names a multi-host rule after the first host", () => {
    const parsed = parseConfig(`rules:\n  - match: [notion.com, notion.so]\n`);
    expect(parsed.rules[0]).toEqual({
      match: [hm("notion.com"), hm("notion.so")],
      action: { kind: "open", containers: ["notion.com"] },
    });
  });

  it("auto-names from the canonical host, not the raw string", () => {
    const parsed = parseConfig(`rules:\n  - match: Notion.COM\n`);
    expect(parsed.rules[0]!.action).toEqual({ kind: "open", containers: ["notion.com"] });
  });

  it("parses open single / multi / default and Temporary passthrough", () => {
    const parsed = parseConfig(
      `rules:\n` +
        `  - match: goflink.com\n    open: Flink\n` +
        `  - match: figma.com\n    open: [Personal, Work]\n` +
        `  - match: trello.com\n    open: [Personal, Work]\n    default: Work\n` +
        `  - match: pinterest.com\n    open: Temporary\n`,
    );
    expect(parsed.rules[0]!.action).toEqual({ kind: "open", containers: ["Flink"] });
    expect(parsed.rules[1]!.action).toEqual({ kind: "open", containers: ["Personal", "Work"] });
    expect(parsed.rules[2]!.action).toEqual({ kind: "open", containers: ["Personal", "Work"], default: "Work" });
    expect(parsed.rules[3]!.action).toEqual({ kind: "open", containers: ["Temporary"] });
  });

  it("parses inherit / ignore / redirector", () => {
    const parsed = parseConfig(
      `rules:\n` +
        `  - match: accounts.google.com\n    inherit: true\n` +
        `  - match: getpocket.com\n    ignore: true\n` +
        `  - match: [t.co, slack-redir.net]\n    redirector: true\n`,
    );
    expect(parsed.rules[0]!.action).toEqual({ kind: "inherit" });
    expect(parsed.rules[1]!.action).toEqual({ kind: "ignore" });
    expect(parsed.rules[2]!.action).toEqual({ kind: "redirector" });
    expect(parsed.rules[2]!.match).toEqual([hm("t.co"), hm("slack-redir.net")]);
  });

  it("surfaces both the cookies and scripts overlays on one rule", () => {
    const parsed = parseConfig(
      `rules:\n  - match: youtube.com\n    open: Temporary\n` +
        `    cookies:\n      - { name: wide, url: "https://www.youtube.com/", value: "1" }\n` +
        `    scripts:\n      - { at: document_start, run: "noop()" }\n`,
    );
    expect(parsed.rules[0]).toEqual({
      match: [hm("youtube.com")],
      action: { kind: "open", containers: ["Temporary"] },
      cookies: [{ name: "wide", url: "https://www.youtube.com/", value: "1" }],
      scripts: [{ at: "document_start", run: "noop()" }],
    });
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

  // `tmp<N>` is what the registry mints for a throwaway, and the name is the only thing
  // that tells the two apart: a permanent container named `tmp1` is deleted by the
  // disposer once its last tab closes, and until then a tab in it reads as already-in-a-
  // throwaway. Both are silent, so the config is refused instead. Only the exact shape:
  // `tmpwork` and `tmpfiles.org` are ordinary names and stay legal.
  it("rejects a container named like a throwaway, wherever the name comes from", () => {
    const fromOpen = err(`rules:\n  - match: x.com\n    open: tmp1\n`);
    expect(fromOpen.message).toMatch(/reserved name of a throwaway/);
    expect(fromOpen.path).toBe("rules[0].open");

    const fromList = err(`rules:\n  - match: x.com\n    open: [Work, tmp42]\n`);
    expect(fromList.path).toBe("rules[0].open[1]");

    // Nobody typed a container name here at all: `tmp1` is a legal hostname, and an
    // action-less rule names its container after it.
    const fromAutoName = err(`rules:\n  - match: tmp1\n`);
    expect(fromAutoName.message).toMatch(/reserved name of a throwaway/);
    expect(fromAutoName.path).toBe("rules[0].match[0]");

    for (const name of ["tmpwork", "tmpfiles.org", "tmp", "Temporary"]) {
      expect(() => parseConfig(`rules:\n  - match: x.com\n    open: ${name}\n`)).not.toThrow();
    }
  });

  it("rejects an unknown key", () => {
    expect(err(`rules:\n  - match: x.com\n    opne: X\n`).message).toMatch(/unknown key "opne"/);
  });

  it("rejects a missing match", () => {
    expect(err(`rules:\n  - open: X\n`).message).toMatch(/missing "match"/);
  });

  // The other two grammars, told apart by shape: "://" makes a string a match pattern,
  // a mapping makes it a regex. Both reach the resolver as opaque matchers, so what is
  // pinned here is that the parser BUILT one — a rule that silently dropped its matcher
  // would parse just as quietly.
  it("accepts a match pattern and a regex, and matches through them", () => {
    const c = parseConfig(`rules:\n  - match: "https://app.example.com/work/*"\n    open: Work\n  - match: { regex: "^https?://([^/]+\\\\.)?google\\\\.[a-z]{2,3}/" }\n    open: Google\n`);
    expect(matchRule("https://app.example.com/work/x", c.rules)).toBe(c.rules[0]);
    expect(matchRule("https://app.example.com/elsewhere", c.rules)).toBeNull();
    expect(matchRule("https://www.google.be/", c.rules)).toBe(c.rules[1]);
  });

  it("rejects a malformed pattern and an uncompilable regex, with the yaml path", () => {
    const p = err(`rules:\n  - match: "ftp://x.com/*"\n    open: X\n`);
    expect(p.message).toMatch(/unsupported scheme "ftp"/);
    expect(p.path).toBe("rules[0].match[0]");
    const r = err(`rules:\n  - match: { regex: "(" }\n    open: X\n`);
    expect(r.message).toMatch(/not a valid regular expression/);
    expect(r.path).toBe("rules[0].match[0]");
    expect(err(`rules:\n  - match: { rgex: "x" }\n    open: X\n`).message).toMatch(/unknown key "rgex"/);
    expect(err(`rules:\n  - match: { regex: 7 }\n    open: X\n`).message).toMatch(/regex must be a string/);
    expect(err(`rules:\n  - match: [7]\n    open: X\n`).message).toMatch(/hostname, a match pattern, or/);
  });

  // Auto-naming reads the first match entry as a hostname; a pattern or regex has none,
  // so the rule has to say where it opens. Refused rather than guessed: `*://*.x.com/a`
  // has three defensible names and a regex has no name at all.
  it("rejects an action-less rule whose first match has no hostname", () => {
    const e = err(`rules:\n  - match: "https://app.example.com/work/*"\n`);
    expect(e.message).toMatch(/no host to name a container after/);
    expect(e.path).toBe("rules[0]");
    expect(err(`rules:\n  - match: { regex: "^https://x/" }\n`).message).toMatch(/no host to name a container after/);
    // A bare host FIRST still auto-names, whatever follows it.
    const ok = parseConfig(`rules:\n  - match: [x.com, "https://y.com/*"]\n`);
    expect(ok.rules[0]!.action).toEqual({ kind: "open", containers: ["x.com"] });
  });

  // A content script is registered by URL pattern before any navigation happens, and a
  // regex has no pattern form. The alternatives are injecting on `*://*/*` — the
  // snippet on every page the user opens — or on a subset of what the rule routes, so
  // the config is refused instead. `cookies` are seeded per navigation and need none of
  // this, which is why only `scripts` is affected.
  it("rejects scripts on a regex rule, and allows cookies on one", () => {
    const e = err(`rules:\n  - match: { regex: "^https://x/" }\n    open: X\n    scripts:\n      - { run: "1" }\n`);
    expect(e.message).toMatch(/regex match/);
    expect(e.path).toBe("rules[0].scripts");
    const c = parseConfig(`rules:\n  - match: { regex: "^https://x/" }\n    open: X\n    cookies:\n      - { name: a, url: "https://x/" }\n`);
    expect(c.rules[0]!.cookies).toHaveLength(1);
    // A pattern HAS a pattern form, so scripts on one are fine.
    const q = parseConfig(`rules:\n  - match: "https://x.com/a/*"\n    open: X\n    scripts:\n      - { run: "1" }\n`);
    expect(q.rules[0]!.scripts).toHaveLength(1);
  });

  // A wildcard with no scheme is the near-miss worth naming: it is what somebody writes
  // who means the match pattern, and it is not one — Firefox's grammar has no pattern
  // without a scheme either.
  it("rejects a bare glob match entry, pointing at the pattern form", () => {
    for (const host of ["*.example.com", "ex?mple.com", "[abc].com"]) {
      const e = err(`rules:\n  - match: "${host}"\n`);
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.message).toMatch(/not a bare hostname/);
      expect(e.message).toMatch(/\*:\/\/\*\.example\.com\/\*/); // names the form that would work
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

  // A top-level typo costs the WHOLE config: `rulez:` leaves nothing matching anything, so
  // every site opens in a throwaway with the editor reporting no problem at all.
  it("rejects an unknown top-level key", () => {
    const e = err(`rulez:\n  - match: x.com\n`);
    expect(e.message).toMatch(/unknown key "rulez" at the top level/);
    expect(e.path).toBe("rulez");
  });

  // The one thing that key could legitimately have been: somewhere to park a YAML anchor.
  // An anchor needs a node to attach to, and every node in this grammar is spoken for, so
  // `x-` is the space kept clear for one.
  it("ignores a top-level key reserved with x-", () => {
    const c = parseConfig(`x-shared: &work Work\nrules:\n  - match: x.com\n    open: *work\n`);
    expect(c.rules[0]!.action).toEqual({ kind: "open", containers: ["Work"] });
  });
});
