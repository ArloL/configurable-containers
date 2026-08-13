import { describe, it, expect } from "vitest";
import { hostMatcher, matches, matcherToPatterns } from "../../src/matcher/matcher";

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

  // Plain http is not a legacy detail here: a rule has to hold for the http hop of a
  // site that upgrades, for a LAN host, and for the harness server every e2e case
  // navigates to. Everything else in this file is https, so nothing else would notice
  // the scheme check narrowing to https alone.
  it("matches http as well as https", () => {
    expect(matches(bandcamp, "http://bandcamp.com/")).toBe(true);
    expect(matches(bandcamp, "http://www.bandcamp.com/x")).toBe(true);
    expect(matches(bandcamp, "http://notbandcamp.com/")).toBe(false);
  });

  // The message names the value, because both throws here are read by a person: a rule
  // that will not load is a rule the user has to find in their config, and `config/parse`
  // only re-states this one with the yaml path attached.
  it("hostMatcher rejects non-hostnames, naming the value it rejected", () => {
    expect(() => hostMatcher("bandcamp.com/path")).toThrow('not a bare hostname: "bandcamp.com/path"');
    expect(() => hostMatcher("has space.com")).toThrow('not a bare hostname: "has space.com"');
    expect(() => hostMatcher("https://bandcamp.com")).toThrow("not a bare hostname");
    expect(() => hostMatcher("bandcamp.com:8443")).toThrow("not a bare hostname"); // a port is not part of a host
    expect(() => hostMatcher("user@bandcamp.com")).toThrow("not a bare hostname"); // nor is userinfo
    expect(() => hostMatcher("bandcamp.com?x=1")).toThrow("not a bare hostname");
    expect(() => hostMatcher("bandcamp.com#frag")).toThrow("not a bare hostname");
    // Rejected by the URL parser rather than by the character class: these carry none of
    // the punctuation the class looks for, and are still not hostnames. The catch has to
    // re-raise as the same rejection — letting the parser's own TypeError out would reach
    // the options page as "Cannot read properties of undefined".
    expect(() => hostMatcher("")).toThrow('not a bare hostname: ""');
    expect(() => hostMatcher("[")).toThrow('not a bare hostname: "["');
    expect(() => hostMatcher("xn--")).toThrow('not a bare hostname: "xn--"'); // undecodable punycode
  });
});

// The script-injector registers content scripts against URL patterns, not URLs, so this
// is where a matcher's meaning has to survive being restated in Firefox's grammar: the
// pair of patterns must cover exactly what matches() answers true for.
describe("matcherToPatterns", () => {
  it("expands a host matcher to the host and its subdomains", () => {
    expect(matcherToPatterns(hostMatcher("bandcamp.com")))
      .toEqual(["*://bandcamp.com/*", "*://*.bandcamp.com/*"]);
  });

  it("expands the canonical host, not the string the user wrote", () => {
    expect(matcherToPatterns(hostMatcher("BandCamp.COM.")))
      .toEqual(["*://bandcamp.com/*", "*://*.bandcamp.com/*"]);
    expect(matcherToPatterns(hostMatcher("münchen.de")))
      .toEqual(["*://xn--mnchen-3ya.de/*", "*://*.xn--mnchen-3ya.de/*"]);
  });
});
