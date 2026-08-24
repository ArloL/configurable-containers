import { describe, it, expect } from "vitest";
import { ConfigError, parseConfig } from "../../src/config/parse";

// Every way the parser refuses a config, with the words it refuses in.
//
// Two reasons this is a table rather than prose cases. The diagnostics ARE the product
// here: a config is hand-written YAML, the extension reloads on save, and a rejected one
// leaves every site opening in a throwaway until the user can see what is wrong (a broken
// stored config never falls back to the seed — see load.ts). And the `path` is what the
// options page underlines, so a wrong one points the user at the wrong line.
//
// Before this table, a third of these branches were reached by no test at all, and most of
// the rest were reached without anything looking at what came back: emptying every message
// in the file changed no result.

function rejection(yaml: string): ConfigError {
  try {
    parseConfig(yaml);
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  return expect.unreachable(`parseConfig accepted:\n${yaml}`);
}

describe("every way a config is refused", () => {
  it.each([
    [
      "regex mapping with an unknown key",
      `rules:\n  - match: { rx: "^https://x/" }\n    open: A\n`,
      "unknown key \"rx\" in rules[0].match[0] (a regex match is { regex: \"\u2026\" })",
      "rules[0].match[0]",
    ],
    [
      "regex that is not a string",
      `rules:\n  - match: { regex: 5 }\n    open: A\n`,
      "rules[0].match[0].regex must be a string",
      "rules[0].match[0].regex",
    ],
    [
      "regex that does not compile",
      `rules:\n  - match: { regex: "(" }\n    open: A\n`,
      "rules[0].match[0]: not a valid regular expression: \"(\"",
      "rules[0].match[0]",
    ],
    [
      "match entry that is not a string or mapping",
      `rules:\n  - match: 5\n    open: A\n`,
      "rules[0].match[0]: a match entry is a hostname, a match pattern, or { regex: \"\u2026\" }",
      "rules[0].match[0]",
    ],
    [
      "match pattern that does not parse",
      `rules:\n  - match: "https://"\n    open: A\n`,
      "rules[0].match[0]: not a valid match pattern (a pattern needs a path, as in \"*://example.com/*\"): \"https://\"",
      "rules[0].match[0]",
    ],
    [
      "glob with no scheme",
      `rules:\n  - match: "*.example.com"\n    open: A\n`,
      "rules[0].match[0]: \"*.example.com\" is not a bare hostname \u2014 a wildcard needs the full pattern form, as in \"*://*.example.com/*\"",
      "rules[0].match[0]",
    ],
    [
      "hostname that is not one",
      `rules:\n  - match: "exa mple.com"\n    open: A\n`,
      "rules[0].match[0]: not a bare hostname: \"exa mple.com\"",
      "rules[0].match[0]",
    ],
    [
      "empty match list",
      `rules:\n  - match: []\n    open: A\n`,
      "rules[0].match must not be empty",
      "rules[0].match",
    ],
    [
      "container named tmp1",
      `rules:\n  - match: x.com\n    open: tmp1\n`,
      "rules[0].open \"tmp1\" is the reserved name of a throwaway container (tmp + a number), which the disposer deletes once it is empty; pick another name",
      "rules[0].open",
    ],
    [
      "auto-named rule for a host called tmp3",
      `rules:\n  - match: tmp3\n`,
      "rules[0].match[0] \"tmp3\" is the reserved name of a throwaway container (tmp + a number), which the disposer deletes once it is empty; pick another name",
      "rules[0].match[0]",
    ],
    [
      "empty open string",
      `rules:\n  - match: x.com\n    open: ""\n`,
      "rules[0].open must not be an empty container name",
      "rules[0].open",
    ],
    [
      "open list entry that is not a string",
      `rules:\n  - match: x.com\n    open: [A, 5]\n`,
      "rules[0].open[1] must be a container name (string)",
      "rules[0].open[1]",
    ],
    [
      "open list entry that is empty",
      `rules:\n  - match: x.com\n    open: ["", A]\n`,
      "rules[0].open[0] must not be an empty container name",
      "rules[0].open[0]",
    ],
    [
      "empty open list",
      `rules:\n  - match: x.com\n    open: []\n`,
      "rules[0].open must not be empty",
      "rules[0].open",
    ],
    [
      "open that is neither string nor list",
      `rules:\n  - match: x.com\n    open: 5\n`,
      "rules[0].open must be a string or a list of strings",
      "rules[0].open",
    ],
    [
      "cookie that is not a mapping",
      `rules:\n  - match: x.com\n    open: A\n    cookies: [5]\n`,
      "rules[0].cookies[0] must be a mapping",
      "rules[0].cookies[0]",
    ],
    [
      "unknown cookie key",
      `rules:\n  - match: x.com\n    open: A\n    cookies:\n      - { name: n, url: "https://x.com/", nope: 1 }\n`,
      "unknown key \"nope\" in rules[0].cookies[0]",
      "rules[0].cookies[0]",
    ],
    [
      "cookie with no name",
      `rules:\n  - match: x.com\n    open: A\n    cookies:\n      - { url: "https://x.com/" }\n`,
      "rules[0].cookies[0].name is required and must be a non-empty string",
      "rules[0].cookies[0].name",
    ],
    [
      "cookie value that is not a string",
      `rules:\n  - match: x.com\n    open: A\n    cookies:\n      - { name: n, url: "https://x.com/", value: 5 }\n`,
      "rules[0].cookies[0].value must be a string",
      "rules[0].cookies[0].value",
    ],
    [
      "cookie secure that is not a boolean",
      `rules:\n  - match: x.com\n    open: A\n    cookies:\n      - { name: n, url: "https://x.com/", secure: 5 }\n`,
      "rules[0].cookies[0].secure must be a boolean",
      "rules[0].cookies[0].secure",
    ],
    [
      "cookie sameSite that is not one of the three",
      `rules:\n  - match: x.com\n    open: A\n    cookies:\n      - { name: n, url: "https://x.com/", sameSite: nope }\n`,
      "rules[0].cookies[0].sameSite must be one of no_restriction, lax, strict",
      "rules[0].cookies[0].sameSite",
    ],
    [
      "cookie expirationDate that is not a number",
      `rules:\n  - match: x.com\n    open: A\n    cookies:\n      - { name: n, url: "https://x.com/", expirationDate: soon }\n`,
      "rules[0].cookies[0].expirationDate must be a number",
      "rules[0].cookies[0].expirationDate",
    ],
    [
      "cookie partitionKey that is not an object",
      `rules:\n  - match: x.com\n    open: A\n    cookies:\n      - { name: n, url: "https://x.com/", partitionKey: 5 }\n`,
      "rules[0].cookies[0].partitionKey must be an object",
      "rules[0].cookies[0].partitionKey",
    ],
    [
      "cookies that are not a list",
      `rules:\n  - match: x.com\n    open: A\n    cookies: 5\n`,
      "rules[0].cookies must be a list",
      "rules[0].cookies",
    ],
    [
      "script that is not a mapping",
      `rules:\n  - match: x.com\n    open: A\n    scripts: [5]\n`,
      "rules[0].scripts[0] must be a mapping",
      "rules[0].scripts[0]",
    ],
    [
      "unknown script key",
      `rules:\n  - match: x.com\n    open: A\n    scripts:\n      - { run: "x", nope: 1 }\n`,
      "unknown key \"nope\" in rules[0].scripts[0]",
      "rules[0].scripts[0]",
    ],
    [
      "script with no run",
      `rules:\n  - match: x.com\n    open: A\n    scripts:\n      - { at: document_start }\n`,
      "rules[0].scripts[0].run is required and must be a non-empty string",
      "rules[0].scripts[0].run",
    ],
    [
      "script run that is not a string",
      `rules:\n  - match: x.com\n    open: A\n    scripts:\n      - { run: 5 }\n`,
      "rules[0].scripts[0].run must be a string",
      "rules[0].scripts[0].run",
    ],
    [
      "script at that is not one of the three",
      `rules:\n  - match: x.com\n    open: A\n    scripts:\n      - { run: "x", at: whenever }\n`,
      "rules[0].scripts[0].at must be one of document_start, document_end, document_idle",
      "rules[0].scripts[0].at",
    ],
    [
      "scripts that are not a list",
      `rules:\n  - match: x.com\n    open: A\n    scripts: 5\n`,
      "rules[0].scripts must be a list",
      "rules[0].scripts",
    ],
    [
      "rule that is not a mapping",
      `rules:\n  - 5\n`,
      "rules[0] must be a mapping",
      "rules[0]",
    ],
    [
      "unknown rule key",
      `rules:\n  - match: x.com\n    open: A\n    nope: 1\n`,
      "unknown key \"nope\" in rules[0]",
      "rules[0]",
    ],
    [
      "rule with no match",
      `rules:\n  - open: A\n`,
      "rules[0] is missing \"match\"",
      "rules[0]",
    ],
    [
      "two actions on one rule",
      `rules:\n  - match: x.com\n    open: A\n    inherit: true\n`,
      "rules[0] has more than one action (open, inherit); a rule has at most one action",
      "rules[0]",
    ],
    [
      "no action and no bare hostname to name after",
      `rules:\n  - match: "https://x.com/*"\n`,
      "rules[0] has no action and its first match is not a bare hostname, so there is no host to name a container after; add \"open:\"",
      "rules[0]",
    ],
    [
      "inherit that is not true",
      `rules:\n  - match: x.com\n    inherit: false\n`,
      "rules[0].inherit must be true",
      "rules[0]",
    ],
    [
      "ignore that is not true",
      `rules:\n  - match: x.com\n    ignore: false\n`,
      "rules[0].ignore must be true",
      "rules[0]",
    ],
    [
      "redirector that is not true",
      `rules:\n  - match: x.com\n    redirector: false\n`,
      "rules[0].redirector must be true",
      "rules[0]",
    ],
    [
      "default on a single-container open",
      `rules:\n  - match: x.com\n    open: A\n    default: A\n`,
      "rules[0].default is only valid with a multi-value \"open\"",
      "rules[0].default",
    ],
    [
      "default that is not a string",
      `rules:\n  - match: x.com\n    open: [A, B]\n    default: 5\n`,
      "rules[0].default must be a container name",
      "rules[0].default",
    ],
    [
      "default outside the open list",
      `rules:\n  - match: x.com\n    open: [A, B]\n    default: C\n`,
      "rules[0].default \"C\" is not one of open: [A, B]",
      "rules[0].default",
    ],
    [
      "cookies on an ignore rule",
      `rules:\n  - match: x.com\n    ignore: true\n    cookies:\n      - { name: n, url: "https://x.com/" }\n`,
      "rules[0].cookies is not allowed on an \"ignore\" rule",
      "rules[0].cookies",
    ],
    [
      "scripts on an ignore rule",
      `rules:\n  - match: x.com\n    ignore: true\n    scripts:\n      - { run: "x" }\n`,
      "rules[0].scripts is not allowed on an \"ignore\" rule",
      "rules[0].scripts",
    ],
    [
      "scripts on a regex rule",
      `rules:\n  - match: { regex: "^https://x/" }\n    open: A\n    scripts:\n      - { run: "x" }\n`,
      "rules[0].scripts is not allowed on a rule with a regex match (a content script registers by URL pattern, which a regex has none of); give the script's hosts a rule of their own",
      "rules[0].scripts",
    ],
    [
      "group that is not a list",
      `groups:\n  - 5\n`,
      "groups[0] must be a list of matchers",
      "groups[0]",
    ],
    [
      "empty group",
      `groups:\n  - []\n`,
      "groups[0] must not be empty",
      "groups[0]",
    ],
    [
      "config that is not a mapping",
      `- a\n- b\n`,
      "config must be a mapping with `rules` and/or `groups`",
      undefined,
    ],
    [
      "rules that are not a list",
      `rules: 5\n`,
      "`rules` must be a list",
      "rules",
    ],
    [
      "groups that are not a list",
      `groups: 5\n`,
      "`groups` must be a list",
      "groups",
    ],
  ])("refuses %s", (_label, yaml, message, path: string | undefined) => {
    const e = rejection(yaml);
    expect(e.message).toBe(message);
    expect(e.path).toBe(path);
    expect(e.name).toBe("ConfigError");
  });

  it("refuses a YAML alias it cannot resolve, as a config error like any other", () => {
    // `yaml` raises a plain ReferenceError here and a TypeError for a circular alias —
    // neither a YAMLParseError, so neither carries a line. Unwrapped they would reach the
    // options page as a stringified exception rather than as something it can report.
    const e = rejection(`rules: *nowhere\n`);
    expect(e.message).toMatch(/^YAML error: /);
    expect(e.line).toBeUndefined();
    expect(e.path).toBeUndefined();
  });

  it("refuses a null where a mapping belongs, rather than reading it as an empty one", () => {
    // `typeof null === "object"`, so the null test in isMapping is the whole of the
    // difference between rejecting this and calling Object.keys on null.
    expect(rejection(`rules:\n  -\n`).message).toBe("rules[0] must be a mapping");
    expect(rejection(`rules:\n  - match: x.com\n    open: A\n    cookies:\n      -\n`).message).toBe(
      "rules[0].cookies[0] must be a mapping",
    );
  });

  it("refuses a cookie name or url that is present but empty", () => {
    expect(
      rejection(`rules:\n  - match: x.com\n    open: A\n    cookies:\n      - { name: "", url: "https://x.com/" }\n`).message,
    ).toBe("rules[0].cookies[0].name is required and must be a non-empty string");
    expect(
      rejection(`rules:\n  - match: x.com\n    open: A\n    cookies:\n      - { name: n, url: "" }\n`).message,
    ).toBe("rules[0].cookies[0].url is required and must be a non-empty string");
  });

  it("refuses scripts on a rule where only ONE of several matchers is a regex", () => {
    // The registration is by URL pattern and a regex has none, so one regex anywhere in
    // the match list is enough to make the rule unregisterable — not all of them.
    const e = rejection(
      `rules:\n  - match: [{ regex: "^https://x/" }, y.com]\n    open: A\n    scripts:\n      - { run: "x();" }\n`,
    );
    expect(e.path).toBe("rules[0].scripts");
    expect(e.message).toMatch(/^rules\[0\]\.scripts is not allowed on a rule with a regex match/);
  });

  it("refuses YAML that does not parse, and says where", () => {
    // The wording past the prefix is the yaml library's and moves with it; the line and
    // column are ours to keep, because they are what the options page points at.
    const e = rejection(`rules:\n  - match: [\n`);
    expect(e.message).toMatch(/^YAML syntax error: /);
    expect(e.line).toBe(3);
    expect(e.col).toBe(1);
    expect(e.path).toBeUndefined();
  });
});
