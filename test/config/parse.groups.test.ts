import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/config/parse";
import { hostMatcher as hm, matchGroup } from "../../src/matcher/matcher";

function err(yaml: string): ConfigError {
  try {
    parseConfig(yaml);
  } catch (e) {
    return e as ConfigError;
  }
  throw new Error("expected parseConfig to throw");
}

describe("parseConfig — groups", () => {
  it("parses a list of host groups", () => {
    const parsed = parseConfig(
      `groups:\n  - [google.com, google.de, youtube.com]\n  - [check24.de, check24.com]\n`,
    );
    expect(parsed.groups).toEqual([
      { match: [hm("google.com"), hm("google.de"), hm("youtube.com")] },
      { match: [hm("check24.de"), hm("check24.com")] },
    ]);
  });

  it("rejects a non-list group", () => {
    const e = err(`groups:\n  - google.com\n`);
    expect(e.path).toBe("groups[0]");
    expect(e.message).toMatch(/must be a list/);
  });

  it("rejects an empty group", () => {
    expect(err(`groups:\n  - []\n`).path).toBe("groups[0]");
  });

  // Groups use the same grammar as rules — the regex form is what makes a group of
  // "every Google ccTLD" writable at all, since no match pattern can wildcard a TLD.
  it("accepts a pattern and a regex entry, and matches through them", () => {
    const c = parseConfig(`groups:\n  - [youtube.com, { regex: "^https?://([^/]+\\\\.)?google\\\\.[a-z]{2,3}(\\\\.[a-z]{2})?/" }]\n  - ["https://*.check24.de/*"]\n`);
    expect(matchGroup("https://google.be/", c.groups)).toBe(0);
    expect(matchGroup("https://www.google.co.uk/maps", c.groups)).toBe(0);
    expect(matchGroup("https://youtube.com/", c.groups)).toBe(0);
    expect(matchGroup("https://www.check24.de/", c.groups)).toBe(1);
    expect(matchGroup("https://example.org/", c.groups)).toBeNull();
  });

  it("rejects a malformed entry, naming the group it is in", () => {
    const e = err(`groups:\n  - [google.com]\n  - ["ftp://x.com/*"]\n`);
    expect(e.message).toMatch(/unsupported scheme "ftp"/);
    expect(e.path).toBe("groups[1][0]");
  });
});
