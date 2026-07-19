import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/config/parse";
import { hostMatcher as hm } from "../../src/matcher/matcher";

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
    const c = parseConfig(
      `groups:\n  - [google.com, google.de, youtube.com]\n  - [check24.de, check24.com]\n`,
    );
    expect(c.groups).toEqual([
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

  it("rejects a pattern/regex entry in a group", () => {
    expect(err(`groups:\n  - ["https://x.com/*"]\n`).message).toMatch(/not a bare hostname|bare hostnames only/);
  });
});
