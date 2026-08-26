import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { hostMatcher, matches, matcherToPatterns, patternForUrl, patternMatcher, regexMatcher } from "../../src/matcher/matcher";

// Generate simple lowercase ASCII hostnames of 2–4 labels.
const label = fc.stringMatching(/^[a-z]{1,6}$/);
const arbHost = fc
  .array(label, { minLength: 2, maxLength: 4 })
  .map((labels) => labels.join("."));

// Independent reference: canonical (already lowercase ASCII here) dot-bounded suffix.
function refMatch(bare: string, host: string): boolean {
  return host === bare || host.endsWith("." + bare);
}

describe("matcher — properties", () => {
  it("equivalence: matches() agrees with the reference suffix rule", () => {
    fc.assert(fc.property(arbHost, arbHost, (bare, host) => {
      expect(matches(hostMatcher(bare), `https://${host}/`)).toBe(refMatch(bare, host));
    }));
  });

  it("no cross-domain leakage: a non-suffix host never matches", () => {
    fc.assert(fc.property(arbHost, arbHost, (bare, host) => {
      if (!refMatch(bare, host)) {
        expect(matches(hostMatcher(bare), `https://${host}/`)).toBe(false);
      }
    }));
  });

  it("subdomains of a matched host always match", () => {
    fc.assert(fc.property(arbHost, label, (bare, sub) => {
      expect(matches(hostMatcher(bare), `https://${sub}.${bare}/`)).toBe(true);
    }));
  });

  it("totality: matches() never throws on arbitrary input", () => {
    fc.assert(fc.property(arbHost, fc.string(), (bare, junk) => {
      expect(() => matches(hostMatcher(bare), junk)).not.toThrow();
    }));
  });
});

// Fixed pools: the properties above fuzz the shorthand's host semantics, these two
// fuzz the grammars against each other, which needs URLs that actually hit.
const hosts = ["example.com", "a.example.com", "b.a.example.com", "notexample.com",
  "example.com.evil.tld", "münchen.de", "xn--mnchen-3ya.de", "co.uk", "google.co.uk"];
const paths = ["/", "/work", "/work/", "/work/a/b", "/workshop", "/a.b", "/s?q=cats", "/a#frag"];
const arbUrl = fc.tuple(
  fc.constantFrom("http", "https"),
  fc.constantFrom(...hosts),
  fc.constantFrom("", ".", ":8443"), // the two things a URL's authority carries that are not the host
  fc.constantFrom(...paths),
).map(([scheme, host, tail, path]) => `${scheme}://${host}${tail}${path}`);

describe("matcher — properties across the three grammars", () => {
  // The contract matcherToPatterns exists for, and the one nothing else can check: the
  // script-injector registers content scripts against those patterns while routing asks
  // matches(), so any URL where the two disagree is a page whose overlay fires without
  // its rule, or the other way round. Two independent code paths — the host suffix test
  // and the pattern's host+path machinery — have to give one answer.
  it("a host matcher's patterns cover exactly what it matches", () => {
    fc.assert(fc.property(fc.constantFrom(...hosts), arbUrl, (host, url) => {
      const m = hostMatcher(host);
      const viaPatterns = matcherToPatterns(m).some((p) => matches(patternMatcher(p), url));
      expect(matches(m, url)).toBe(viaPatterns);
    }));
  });

  // The totality property above, restated for the two grammars that reach an engine of
  // their own — a compiled path glob and a compiled regex. A throw inside the blocking
  // handler is not a wrong answer, it is a navigation that never completes.
  // What the pause record promises when it offers a pattern for copying: paste it into
  // `match:` unchanged and the navigation it was built from routes. Both halves are the
  // property — that the parser accepts it at all, and that it then answers true — and
  // neither is checkable from the string alone.
  it("a pattern built from a URL parses, and matches that URL", () => {
    fc.assert(fc.property(arbUrl, (url) => {
      const pattern = patternForUrl(url);
      expect(pattern).not.toBeNull();
      expect(matches(patternMatcher(pattern!), url)).toBe(true);
    }));
  });

  // And it never reaches past the host it came from. A widening here is a rule the user
  // pasted believing it named one site.
  it("a pattern built from a URL matches no other host", () => {
    fc.assert(fc.property(arbUrl, arbUrl, (from, other) => {
      const pattern = patternMatcher(patternForUrl(from)!);
      if (matches(pattern, other)) {
        expect(new URL(other).hostname.replace(/\.$/, "")).toBe(new URL(from).hostname.replace(/\.$/, ""));
      }
    }));
  });

  it("totality: a pattern or regex matcher answers a boolean for any string", () => {
    const arbMatcher = fc.oneof(
      fc.constantFrom("*://*/*", "https://*.example.com/*", "http://example.com/work/*")
        .map((p) => patternMatcher(p)),
      fc.constantFrom("^https?://", "example", "[0-9]+$").map((r) => regexMatcher(r)),
    );
    fc.assert(fc.property(arbMatcher, fc.string(), (m, s) => {
      expect(typeof matches(m, s)).toBe("boolean");
    }));
  });
});
