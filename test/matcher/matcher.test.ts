import { describe, it, expect } from "vitest";
import { hostMatcher, matches } from "../../src/matcher/matcher";

const bandcamp = hostMatcher("bandcamp.com");
const mailGoogle = hostMatcher("mail.google.com");

describe("hostMatcher / matches — shorthand semantics", () => {
  it("matches the bare host and its subdomains", () => {
    expect(matches(bandcamp, "https://bandcamp.com/")).toBe(true);
    expect(matches(bandcamp, "https://www.bandcamp.com/")).toBe(true);
    expect(matches(bandcamp, "https://a.b.bandcamp.com/x?y=1")).toBe(true);
  });

  it("rejects the suffix-match traps", () => {
    expect(matches(bandcamp, "https://notbandcamp.com/")).toBe(false);
    expect(matches(bandcamp, "https://bandcamp.com.evil.tld/")).toBe(false);
    expect(matches(bandcamp, "https://bandcamp.org/")).toBe(false);
  });

  it("a specific-subdomain matcher does not match the parent", () => {
    expect(matches(mailGoogle, "https://mail.google.com/")).toBe(true);
    expect(matches(mailGoogle, "https://inbox.mail.google.com/")).toBe(true);
    expect(matches(mailGoogle, "https://google.com/")).toBe(false);
    expect(matches(mailGoogle, "https://accounts.google.com/")).toBe(false);
  });

  it("canonicalizes case, trailing dot, port, path/query", () => {
    expect(matches(bandcamp, "https://WWW.BANDCAMP.COM/")).toBe(true);
    expect(matches(bandcamp, "https://bandcamp.com./")).toBe(true); // trailing dot
    expect(matches(bandcamp, "https://bandcamp.com:8443/")).toBe(true); // port ignored
    expect(matches(hostMatcher("BandCamp.com"), "https://bandcamp.com/")).toBe(true);
  });

  it("normalizes IDN vs punycode both ways", () => {
    const uni = hostMatcher("münchen.de");
    const puny = hostMatcher("xn--mnchen-3ya.de");
    expect(matches(uni, "https://xn--mnchen-3ya.de/")).toBe(true);
    expect(matches(puny, "https://münchen.de/")).toBe(true);
  });

  it("matches only http/https and never throws on junk", () => {
    expect(matches(bandcamp, "about:blank")).toBe(false);
    expect(matches(bandcamp, "file:///bandcamp.com")).toBe(false);
    expect(matches(bandcamp, "ftp://bandcamp.com/")).toBe(false);
    expect(matches(bandcamp, "not a url")).toBe(false);
    expect(matches(bandcamp, "")).toBe(false);
  });

  it("hostMatcher rejects non-hostnames", () => {
    expect(() => hostMatcher("bandcamp.com/path")).toThrow();
    expect(() => hostMatcher("has space.com")).toThrow();
    expect(() => hostMatcher("")).toThrow();
    expect(() => hostMatcher("https://bandcamp.com")).toThrow();
  });
});
