import { describe, it, expect } from "vitest";
import {
  hostMatcher,
  matches,
  matcherToPatterns,
  patternForUrl,
  patternMatcher,
  regexMatcher,
  MAX_PATTERN_PATH,
} from "../../src/matcher/matcher";

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

  // Plain http is not a legacy detail: a rule has to hold for the http hop of a site that
  // upgrades, for a LAN host, and for the harness server every e2e case navigates to.
  // Everything else here is https, so nothing else would notice the check narrowing.
  it("matches http as well as https", () => {
    expect(matches(bandcamp, "http://bandcamp.com/")).toBe(true);
    expect(matches(bandcamp, "http://www.bandcamp.com/x")).toBe(true);
    expect(matches(bandcamp, "http://notbandcamp.com/")).toBe(false);
  });

  // The message names the value, because a person reads it: a rule that will not load is
  // one the user has to find in their config, and `config/parse` only re-states this with
  // the yaml path attached.
  it("hostMatcher rejects non-hostnames, naming the value it rejected", () => {
    expect(() => hostMatcher("bandcamp.com/path")).toThrow('not a bare hostname: "bandcamp.com/path"');
    expect(() => hostMatcher("has space.com")).toThrow('not a bare hostname: "has space.com"');
    expect(() => hostMatcher("https://bandcamp.com")).toThrow("not a bare hostname");
    expect(() => hostMatcher("bandcamp.com:8443")).toThrow("not a bare hostname"); // a port is not part of a host
    expect(() => hostMatcher("user@bandcamp.com")).toThrow("not a bare hostname"); // nor is userinfo
    expect(() => hostMatcher("bandcamp.com?x=1")).toThrow("not a bare hostname");
    expect(() => hostMatcher("bandcamp.com#frag")).toThrow("not a bare hostname");
    // Rejected by the URL parser, not the character class: these carry none of the
    // punctuation it looks for and are still not hostnames. The catch re-raises as the same
    // rejection — the parser's own TypeError would reach the options page as "Cannot read
    // properties of undefined". Only an input every parser refuses belongs here: `xn--`,
    // an undecodable punycode label, was pinned as one until ada 4.0.0 (Node 24.20.0)
    // began passing it through as a plain host, and two runners in one CI run then
    // disagreed on it. `canonicalHost` owns no IDNA rule of its own, so neither can this.
    expect(() => hostMatcher("")).toThrow('not a bare hostname: ""');
    expect(() => hostMatcher("[")).toThrow('not a bare hostname: "["');
  });
});

// The script-injector registers content scripts against URL patterns, not URLs, so a
// matcher's meaning has to survive being restated in Firefox's grammar: the pair of
// patterns must cover exactly what matches() answers true for.
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

  // A pattern is already one, handed over in CANONICAL form: registering
  // `*://*.BandCamp.COM/*` while matching `bandcamp.com` here would put an overlay's script
  // on a different set of pages than its rule routes.
  it("hands a pattern over as itself, canonicalized", () => {
    expect(matcherToPatterns(patternMatcher("https://app.example.com/work/*")))
      .toEqual(["https://app.example.com/work/*"]);
    expect(matcherToPatterns(patternMatcher("*://*.BandCamp.COM./x")))
      .toEqual(["*://*.bandcamp.com/x"]);
    expect(matcherToPatterns(patternMatcher("*://*/*"))).toEqual(["*://*/*"]);
  });

  // No finite set of patterns describes an arbitrary regex, and the wider one that would
  // compile — `*://*/*` — is the user's snippet on every page they open. `config/parse`
  // keeps this unreachable; the throw makes a hand-built config say so instead of
  // over-injecting.
  it("refuses a regex, which has no pattern form", () => {
    expect(() => matcherToPatterns(regexMatcher("^https://x\\.com/")))
      .toThrow(/no URL-pattern form/);
  });
});

// ── Match patterns ────────────────────────────────────────────────────────────────
// The WebExtension grammar, and the two ways it differs from the shorthand above: a bare
// host is EXACTLY that host (`*.` is what asks for subdomains), and the path is matched,
// so a rule can be narrower than a site.
describe("patternMatcher / matches — WebExtension match patterns", () => {
  it("matches the host it names and, without \"*.\", only that host", () => {
    const exact = patternMatcher("https://app.example.com/*");
    expect(matches(exact, "https://app.example.com/")).toBe(true);
    expect(matches(exact, "https://app.example.com/deep/path?q=1")).toBe(true);
    expect(matches(exact, "https://example.com/")).toBe(false);
    expect(matches(exact, "https://www.app.example.com/")).toBe(false); // "*." not asked for
  });

  it("\"*.\" covers the host and everything under it", () => {
    const sub = patternMatcher("https://*.example.com/*");
    expect(matches(sub, "https://example.com/")).toBe(true);
    expect(matches(sub, "https://a.b.example.com/")).toBe(true);
    expect(matches(sub, "https://notexample.com/")).toBe(false);
    expect(matches(sub, "https://example.com.evil.tld/")).toBe(false);
  });

  it("the bare \"*\" host matches any http(s) host", () => {
    const any = patternMatcher("https://*/admin*");
    expect(matches(any, "https://a.com/admin")).toBe(true);
    expect(matches(any, "https://b.example.org/admin/users")).toBe(true);
    expect(matches(any, "https://a.com/public")).toBe(false);
  });

  it("pins the scheme when it names one, and \"*\" means http+https", () => {
    const secure = patternMatcher("https://example.com/*");
    expect(matches(secure, "http://example.com/")).toBe(false);
    expect(matches(secure, "https://example.com/")).toBe(true);

    const plain = patternMatcher("http://example.com/*");
    expect(matches(plain, "https://example.com/")).toBe(false);
    expect(matches(plain, "http://example.com/")).toBe(true);

    const either = patternMatcher("*://example.com/*");
    expect(matches(either, "http://example.com/")).toBe(true);
    expect(matches(either, "https://example.com/")).toBe(true);
    // Never anything else, whatever the pattern says: a matcher only answers for a
    // top-level http(s) navigation.
    expect(matches(either, "ftp://example.com/")).toBe(false);
    expect(matches(either, "about:blank")).toBe(false);
    expect(matches(either, "not a url")).toBe(false);
  });

  // The path is why a pattern exists at all; a host-shaped rule is shorter as a bare
  // hostname. Anchored at both ends: /work must not be answered by /workshop, nor /b by
  // /a/b.
  it("matches the path glob anchored at both ends", () => {
    const work = patternMatcher("https://app.example.com/work/*");
    expect(matches(work, "https://app.example.com/work/")).toBe(true);
    expect(matches(work, "https://app.example.com/work/a/b")).toBe(true);
    expect(matches(work, "https://app.example.com/workshop/")).toBe(false);
    expect(matches(work, "https://app.example.com/")).toBe(false);

    const exactPath = patternMatcher("https://example.com/a");
    expect(matches(exactPath, "https://example.com/a")).toBe(true);
    expect(matches(exactPath, "https://example.com/ab")).toBe(false); // not a prefix match
    expect(matches(exactPath, "https://example.com/x/a")).toBe(false); // nor a suffix one

    const inner = patternMatcher("https://example.com/*/edit");
    expect(matches(inner, "https://example.com/doc/edit")).toBe(true);
    expect(matches(inner, "https://example.com/a/b/c/edit")).toBe(true); // "*" spans "/"
    expect(matches(inner, "https://example.com/doc/view")).toBe(false);
  });

  // A path glob is a glob, not a regex: everything but "*" is literal. Without the escape
  // "/a.b" would also route "/axb", one rule silently owning a family of pages.
  it("treats regex metacharacters in the path as literals", () => {
    const dotted = patternMatcher("https://example.com/a.b");
    expect(matches(dotted, "https://example.com/a.b")).toBe(true);
    expect(matches(dotted, "https://example.com/axb")).toBe(false);
    const bracketed = patternMatcher("https://example.com/(x)+[y]");
    expect(matches(bracketed, "https://example.com/(x)+[y]")).toBe(true);
    expect(matches(bracketed, "https://example.com/xy")).toBe(false);
  });

  // The config promises query matching ("scheme, host, path, query"). The fragment is
  // deliberately outside it: it never reaches the server.
  it("matches path + query, never the fragment", () => {
    const q = patternMatcher("https://example.com/s?q=cats*");
    expect(matches(q, "https://example.com/s?q=cats")).toBe(true);
    expect(matches(q, "https://example.com/s?q=cats&safe=1")).toBe(true);
    expect(matches(q, "https://example.com/s?q=dogs")).toBe(false);

    const noQuery = patternMatcher("https://example.com/a");
    expect(matches(noQuery, "https://example.com/a#section")).toBe(true); // fragment ignored
    expect(matches(noQuery, "https://example.com/a?x=1")).toBe(false); // query is not
  });

  it("canonicalizes the host it was written with, on both sides", () => {
    const shouty = patternMatcher("*://*.BandCamp.COM./*");
    expect(matches(shouty, "https://www.bandcamp.com/")).toBe(true);
    expect(matches(shouty, "https://bandcamp.com./")).toBe(true); // trailing dot on the URL
    expect(matches(patternMatcher("*://münchen.de/*"), "https://xn--mnchen-3ya.de/")).toBe(true);
  });

  // A person editing their config reads these, so each names what is wrong rather than
  // "invalid pattern".
  it("rejects the malformed patterns, naming what is wrong", () => {
    expect(() => patternMatcher("example.com/*")).toThrow(/needs a scheme/);
    expect(() => patternMatcher("https://example.com")).toThrow(/needs a path/);
    expect(() => patternMatcher("ftp://example.com/*")).toThrow(/unsupported scheme "ftp"/);
    expect(() => patternMatcher("file://*/*")).toThrow(/unsupported scheme "file"/);
    // The one a Google-ccTLD config reaches for first. Not a match pattern in Firefox
    // either, and reading it leniently would look like it covered google.de.
    expect(() => patternMatcher("*://*.google.*/*")).toThrow(/host wildcard/);
    expect(() => patternMatcher("*://*google.com/*")).toThrow(/host wildcard/);
    expect(() => patternMatcher("https://ex ample.com/*")).toThrow(/"ex ample.com" is not a hostname/);
    expect(() => patternMatcher("https://user@example.com/*")).toThrow(/is not a hostname/);
    expect(() => patternMatcher("https://example.com:8443/*")).toThrow(/is not a hostname/); // a port is not
    expect(() => patternMatcher("https:///*")).toThrow(/is not a hostname/); // empty host
    // Every one is an Error carrying that message, and both halves matter: `config/parse`
    // re-raises `(e as Error).message` into the ConfigError the options page prints, so a
    // rejection without one reaches the user as an empty complaint about a line they cannot
    // find.
    for (const bad of ["example.com/*", "ftp://example.com/*", "*://*.google.*/*"]) {
      let thrown: unknown;
      try { patternMatcher(bad); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/not a valid match pattern/);
    }
  });
});

// ── Regex ─────────────────────────────────────────────────────────────────────────
describe("regexMatcher / matches — the escape hatch", () => {
  // The case the form exists for: one expression covering ~190 Google ccTLDs, which no
  // match pattern can express.
  const googleAnyTld = regexMatcher("^https?://([^/]+\\.)?google\\.[a-z]{2,3}(\\.[a-z]{2})?/");

  it("matches every ccTLD shape the pattern grammar cannot", () => {
    for (const url of [
      "https://google.com/", "https://google.be/", "https://www.google.de/search?q=x",
      "https://google.co.uk/", "https://google.com.au/", "https://images.google.fr/",
    ]) {
      expect(matches(googleAnyTld, url)).toBe(true);
    }
    for (const url of ["https://notgoogle.com/", "https://google.evil.tld/", "https://mygoogle.de/"]) {
      expect(matches(googleAnyTld, url)).toBe(false);
    }
  });

  it("is matched against the canonical URL, so an anchored expression holds", () => {
    const anchored = regexMatcher("^https://x\\.com/$");
    expect(matches(anchored, "https://x.com")).toBe(true); // the parser supplies the "/"
    expect(matches(anchored, "https://X.COM")).toBe(true); // and lowercases the host
    expect(matches(anchored, "https://x.com/a")).toBe(false);
    expect(matches(anchored, "https://evil.test/?u=https://x.com/")).toBe(false);
  });

  it("answers false for a non-http(s) URL however permissive the expression", () => {
    const anything = regexMatcher(".");
    expect(matches(anything, "https://a.test/")).toBe(true);
    expect(matches(anything, "about:blank")).toBe(false);
    expect(matches(anything, "moz-extension://abc/choice.html")).toBe(false);
    expect(matches(anything, "not a url")).toBe(false);
  });

  // Compiled while the config is read, because inside the blocking handler there is nobody
  // left to tell: a throw there is a navigation that never resolves.
  it("rejects an uncompilable or empty expression", () => {
    expect(() => regexMatcher("(")).toThrow(/not a valid regular expression/);
    expect(() => regexMatcher("[z-a]")).toThrow(/not a valid regular expression/);
    expect(() => regexMatcher("")).toThrow(/not a valid regular expression: empty/);
  });
});

// The other direction: a URL the pause recorder saw, restated as the `match:` value that
// would route it. The record hands the result straight to the user's clipboard, so what it
// produces has to be a pattern the parser accepts and one that answers true for the URL it
// came from — the two properties the props file fuzzes.
describe("patternForUrl", () => {
  it("keeps the host and the path, which is the whole point of recording a URL", () => {
    // The case this exists for: GitHub's OAuth hand-off has to be routed differently from
    // the rest of github.com, and a record naming only the host cannot say so.
    expect(patternForUrl("https://github.com/login/oauth/authorize?client_id=abc&state=xyz"))
      .toBe("*://github.com/login/oauth/authorize*");
  });

  it("drops the query, which is where the token in a recorded checkout lives", () => {
    expect(patternForUrl("https://pay.test/confirm?session=SECRET123")).toBe("*://pay.test/confirm*");
  });

  it("ends in a wildcard, so the pattern still answers the URL's own query", () => {
    // A pattern's path is anchored at BOTH ends. Without the trailing `*` the pattern built
    // from an OAuth entry point would not match that entry point.
    const url = "https://github.com/login/oauth/authorize?client_id=abc";
    expect(matches(patternMatcher(patternForUrl(url)!), url)).toBe(true);
  });

  it("says `*://` rather than the scheme it saw, because HSTS rewrites that before we look", () => {
    expect(patternForUrl("http://example.com/x")).toBe("*://example.com/x*");
    expect(patternForUrl("https://example.com/x")).toBe("*://example.com/x*");
  });

  it("canonicalizes the host and drops the port, which no pattern can carry", () => {
    expect(patternForUrl("https://BandCamp.COM./a")).toBe("*://bandcamp.com/a*");
    expect(patternForUrl("https://münchen.de/a")).toBe("*://xn--mnchen-3ya.de/a*");
    // A port is not part of a host here either: `https://company.com:8443/` matches
    // `company.com`, so a pattern naming the port would be narrower than the rule it feeds.
    expect(patternForUrl("http://localhost:8443/a")).toBe("*://localhost/a*");
  });

  it("gives a bare URL the root path, not an empty one", () => {
    expect(patternForUrl("https://example.com")).toBe("*://example.com/*");
  });

  it("answers null for anything routing never sees", () => {
    expect(patternForUrl("about:blank")).toBeNull();
    expect(patternForUrl("moz-extension://abc/options.html")).toBeNull();
    expect(patternForUrl("not a url")).toBeNull();
  });

  it("answers null for a host no pattern can name, rather than a string that will not parse", () => {
    // An IPv6 literal carries colons, which the pattern grammar's host cannot. Returning
    // the string anyway would put text in the record that the config editor then rejects.
    expect(patternForUrl("http://[::1]/x")).toBeNull();
  });

  it("truncates a very long path, and the result still matches the URL it came from", () => {
    const path = "/" + "a".repeat(MAX_PATTERN_PATH * 2);
    const url = `https://example.com${path}`;
    const pattern = patternForUrl(url)!;

    // A prefix plus the trailing `*`: wider than the URL, never narrower, and bounded —
    // the record it feeds is written to disk on every navigation of an armed container.
    expect(pattern).toBe(`*://example.com${path.slice(0, MAX_PATTERN_PATH)}*`);
    expect(matches(patternMatcher(pattern), url)).toBe(true);
  });
});
