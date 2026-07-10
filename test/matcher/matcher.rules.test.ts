import { describe, it, expect } from "vitest";
import { hostMatcher, matchRule, matchGroup } from "../../src/matcher/matcher";
import type { Rule, Group } from "../../src/resolver/types";

// Rules carry canonical HostMatchers in their `match` arrays (as the config parser
// will produce). Rule.action is irrelevant to matching; use a minimal open action.
const open = (name: string) => ({ kind: "open" as const, containers: [name] });

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
