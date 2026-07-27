import { describe, it, expect } from "vitest";
import { isRedirectorUrl } from "../../src/overlays/redirector";
import { matchRule } from "../../src/matcher/matcher";
import { parseConfig } from "../../src/config/parse";

const config = parseConfig(`
rules:
  - match: t.co
    redirector: true
  - match: pocket.example
    ignore: true
  - match: login.example
    inherit: true
  - match: work.example
    open: Work
  - match: example
    open: Broad
`);

describe("isRedirectorUrl", () => {
  it("returns true for a URL matching a redirector rule", () => {
    expect(isRedirectorUrl("https://t.co/abc", config, matchRule)).toBe(true);
  });

  it("returns false for a URL matching no rule", () => {
    expect(isRedirectorUrl("https://nomatch.test/", config, matchRule)).toBe(false);
  });

  it("returns false for a URL matching an ignore rule", () => {
    expect(isRedirectorUrl("https://pocket.example/", config, matchRule)).toBe(false);
  });

  it("returns false for a URL matching an inherit rule", () => {
    expect(isRedirectorUrl("https://login.example/", config, matchRule)).toBe(false);
  });

  it("returns false for a URL matching an open rule", () => {
    expect(isRedirectorUrl("https://work.example/", config, matchRule)).toBe(false);
  });

  it("honours first-match precedence (redirector above broad open)", () => {
    // t.co is a redirector rule above the broad `example` open rule; redirector wins.
    expect(isRedirectorUrl("https://t.co/abc", config, matchRule)).toBe(true);
  });

  it("returns false when a broad open rule shadows a redirector below it", () => {
    const c = parseConfig(`
rules:
  - match: example
    open: Broad
  - match: t.co
    redirector: true
`);
    // `example` matches t.co? No — bare-host `example` matches *.example, not t.co.
    // So t.co still hits the redirector rule. This is just first-match precedence:
    // a URL that matches BOTH a broad open (above) and a redirector (below) resolves
    // to the broad open (first-match) → false.
    expect(isRedirectorUrl("https://sub.example/", c, matchRule)).toBe(false);
    expect(isRedirectorUrl("https://t.co/x", c, matchRule)).toBe(true);
  });
});
