import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { hostMatcher, matches } from "../../src/matcher/matcher";

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
