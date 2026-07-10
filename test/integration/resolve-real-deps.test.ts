import { describe, it, expect } from "vitest";
import { resolve } from "../../src/resolver/resolve";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Deps, NavContext, Config, ContainerRef } from "../../src/resolver/types";

// The REAL production dependencies (host-grammar matcher + PSL same-site).
const deps: Deps = { matchRule, matchGroup, sameSite };

const temp: ContainerRef = { kind: "temporary" };
function nav(targetUrl: string, currentUrl: string): NavContext {
  return { targetUrl, current: { url: currentUrl, container: temp }, initiator: null };
}

describe("resolve() on real matcher + real PSL", () => {
  const noRules: Config = { rules: [], groups: [] };

  it("isolates across the co.uk public suffix (the real trap)", () => {
    const d = resolve(nav("https://theguardian.co.uk/", "https://bbc.co.uk/"), noRules, deps);
    expect(d).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("keeps continuity within a registrable domain", () => {
    const d = resolve(nav("https://old.reddit.com/", "https://www.reddit.com/"), noRules, deps);
    expect(d).toEqual({ kind: "stay" });
  });

  it("isolates across private-suffix domains (github.io)", () => {
    const d = resolve(nav("https://bar.github.io/", "https://foo.github.io/"), noRules, deps);
    expect(d).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("keeps continuity across a real group with real host matchers", () => {
    const cfg: Config = {
      rules: [],
      groups: [{ match: [hostMatcher("google.com"), hostMatcher("youtube.com")] }],
    };
    const d = resolve(nav("https://youtube.com/", "https://google.com/"), cfg, deps);
    expect(d).toEqual({ kind: "stay" });
  });
});
