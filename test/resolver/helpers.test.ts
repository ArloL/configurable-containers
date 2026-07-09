import { describe, it, expect } from "vitest";
import { makeDeps, host } from "./helpers";
import type { Rule, Group } from "../../src/resolver/types";

const deps = makeDeps();

describe("test Deps doubles", () => {
  it("matchRule matches host and subdomains, first-match wins", () => {
    const rules: Rule[] = [
      { match: ["mail.google.com"], action: { kind: "open", containers: ["Gmail"] } },
      { match: ["google.com"], action: { kind: "open", containers: ["G"] } },
    ];
    expect(deps.matchRule("https://mail.google.com/x", rules)).toBe(rules[0]);
    expect(deps.matchRule("https://www.google.com/", rules)).toBe(rules[1]);
    expect(deps.matchRule("https://notgoogle.com/", rules)).toBeNull();
  });

  it("matchGroup returns the first matching group index", () => {
    const groups: Group[] = [
      { match: ["google.com", "youtube.com"] },
      { match: ["check24.de"] },
    ];
    expect(deps.matchGroup("https://youtube.com/", groups)).toBe(0);
    expect(deps.matchGroup("https://check24.de/", groups)).toBe(1);
    expect(deps.matchGroup("https://example.org/", groups)).toBeNull();
  });

  it("sameSite compares the last two labels", () => {
    expect(deps.sameSite("https://a.google.com/", "https://b.google.com/x")).toBe(true);
    expect(deps.sameSite("https://reddit.com/", "https://old.reddit.com/")).toBe(true);
    expect(deps.sameSite("https://reddit.com/", "https://imgur.com/")).toBe(false);
  });

  it("host() extracts a hostname", () => {
    expect(host("https://mail.google.com/path?q=1")).toBe("mail.google.com");
  });
});
