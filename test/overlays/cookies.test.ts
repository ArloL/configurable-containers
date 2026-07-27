import { describe, it, expect } from "vitest";
import { cookiesFor, parseCookieHeader, writeCookieHeader } from "../../src/overlays/cookies";
import { matchRule } from "../../src/matcher/matcher";
import { parseConfig } from "../../src/config/parse";

const config = parseConfig(`
rules:
  - match: specific.example
    open: A
    cookies:
      - { name: s, url: "https://specific.example/", value: "1" }
  - match: pocket.example
    ignore: true
  - match: example
    open: B
    cookies:
      - { name: e, url: "https://example/", value: "2" }
`);

describe("cookiesFor", () => {
  it("returns the matched rule's cookies", () => {
    expect(cookiesFor("https://specific.example/", config, matchRule)).toEqual([
      { name: "s", url: "https://specific.example/", value: "1" },
    ]);
  });

  it("returns [] when no rule matches", () => {
    expect(cookiesFor("https://nomatch.test/", config, matchRule)).toEqual([]);
  });

  it("returns [] for a matched ignore rule", () => {
    expect(cookiesFor("https://pocket.example/", config, matchRule)).toEqual([]);
  });

  it("honours first-match precedence (specific above broad)", () => {
    // specific.example is a subdomain-style match above the broad `example` rule;
    // the specific rule wins, so we get its cookie, not the broad one.
    expect(cookiesFor("https://specific.example/", config, matchRule)).toEqual([
      { name: "s", url: "https://specific.example/", value: "1" },
    ]);
  });

  it("returns [] for a rule that matches but carries no cookies", () => {
    const c = parseConfig(`rules:\n  - match: bare.example\n    open: C\n`);
    expect(cookiesFor("https://bare.example/", c, matchRule)).toEqual([]);
  });
});

describe("parseCookieHeader / writeCookieHeader", () => {
  it("parses an absent Cookie header to an empty jar", () => {
    expect(parseCookieHeader([{ name: "Accept", value: "*/*" }])).toEqual({});
  });

  it("parses a populated Cookie header into a jar", () => {
    expect(parseCookieHeader([{ name: "Cookie", value: "a=1; b=2" }])).toEqual({ a: "1", b: "2" });
  });

  it("appends a Cookie header when none existed", () => {
    const out = writeCookieHeader([{ name: "Accept", value: "*/*" }], { a: "1" });
    expect(out).toContainEqual({ name: "Accept", value: "*/*" });
    expect(out).toContainEqual({ name: "Cookie", value: "a=1" });
  });

  it("replaces an existing Cookie header (case-insensitive)", () => {
    const out = writeCookieHeader([{ name: "cookie", value: "a=1" }], { a: "1", b: "2" });
    expect(out.filter((h) => h.name.toLowerCase() === "cookie")).toEqual([{ name: "Cookie", value: "a=1; b=2" }]);
  });

  it("round-trips parse -> write", () => {
    const headers = [{ name: "Cookie", value: "a=1; b=2" }];
    const jar = parseCookieHeader(headers);
    jar.c = "3";
    expect(parseCookieHeader(writeCookieHeader(headers, jar))).toEqual({ a: "1", b: "2", c: "3" });
  });
});
