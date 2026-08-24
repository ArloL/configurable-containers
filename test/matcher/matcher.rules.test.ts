import { describe, it, expect } from "vitest";
import { hostMatcher, matchRule, matchGroup, patternMatcher, regexMatcher } from "../../src/matcher/matcher";
import type { Rule, Group } from "../../src/resolver/types";

// Rules carry canonical HostMatchers in their `match` arrays (as the config parser
// will produce). Rule.action is irrelevant to matching; use a minimal open action.
const open = (name: string) => ({ kind: "open" as const, containers: [name] as [string] });

const rules: Rule[] = [
  { match: [hostMatcher("mail.google.com")], action: open("Gmail") },
  { match: [hostMatcher("google.com")], action: open("G") },
  { match: [hostMatcher("trello.com"), hostMatcher("atlassian.net")], action: open("Work") }, // any-of
];

const groups: Group[] = [
  { match: [hostMatcher("google.com"), hostMatcher("youtube.com")] },
  { match: [hostMatcher("check24.de")] },
];

describe("matchRule — first-match, any-of", () => {
  it("returns the first rule whose any matcher hits", () => {
    expect(matchRule("https://mail.google.com/", rules)).toBe(rules[0]);
    expect(matchRule("https://www.google.com/", rules)).toBe(rules[1]);
    expect(matchRule("https://x.atlassian.net/", rules)).toBe(rules[2]); // second matcher of an any-of
  });

  it("returns null when nothing matches", () => {
    expect(matchRule("https://example.org/", rules)).toBeNull();
    expect(matchRule("about:blank", rules)).toBeNull();
  });
});

describe("matchGroup — first-match index", () => {
  it("returns the first matching group's index", () => {
    expect(matchGroup("https://youtube.com/", groups)).toBe(0);
    expect(matchGroup("https://check24.de/", groups)).toBe(1);
  });

  it("returns null when no group matches", () => {
    expect(matchGroup("https://example.org/", groups)).toBeNull();
  });
});

// The three grammars in one list, which is how a real config mixes them: a narrow
// path-scoped pattern above the site's own rule. First-match-wins has to be decided by
// POSITION and not by grammar — a pattern that does not match must fall through to the
// host rule under it, or path-scoped routing would swallow the whole site.
describe("matchRule — the three grammars in one list", () => {
  const mixed: Rule[] = [
    { match: [patternMatcher("https://app.example.com/work/*")], action: open("Work") },
    { match: [hostMatcher("app.example.com")], action: open("Personal") },
    { match: [regexMatcher("^https?://([^/]+\\.)?google\\.[a-z]{2,3}(\\.[a-z]{2})?/")], action: open("Google") },
  ];

  it("takes the first rule that matches, whatever grammar it is written in", () => {
    expect(matchRule("https://app.example.com/work/x", mixed)).toBe(mixed[0]);
    expect(matchRule("https://app.example.com/personal", mixed)).toBe(mixed[1]); // pattern fell through
    expect(matchRule("https://www.google.be/search?q=x", mixed)).toBe(mixed[2]);
    expect(matchRule("https://example.org/", mixed)).toBeNull();
  });

  it("matches a group written as a regex — the whole point of the escape hatch", () => {
    const g: Group[] = [{ match: [regexMatcher("^https?://([^/]+\\.)?google\\.[a-z]{2,3}(\\.[a-z]{2})?/"), hostMatcher("youtube.com")] }];
    expect(matchGroup("https://google.de/", g)).toBe(0);
    expect(matchGroup("https://google.co.uk/maps", g)).toBe(0);
    expect(matchGroup("https://youtube.com/watch", g)).toBe(0); // still an any-of with hosts
    expect(matchGroup("https://google.evil.tld/", g)).toBeNull();
  });
});
