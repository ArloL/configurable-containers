import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { sameSite } from "../../src/psl/same-site";

// A small pool of real-ish hosts spanning several registrable domains + a null case.
const hostPool = [
  "https://example.com/",
  "https://www.example.com/",
  "https://example.org/",
  "https://bbc.co.uk/",
  "https://theguardian.co.uk/",
  "https://foo.github.io/",
  "https://bar.github.io/",
  "http://127.0.0.1/",
  "http://localhost/",
];
const arbUrl = fc.constantFrom(...hostPool);

describe("sameSite — properties", () => {
  it("reflexive for real URLs", () => {
    fc.assert(fc.property(arbUrl, (u) => {
      expect(sameSite(u, u)).toBe(true);
    }));
  });

  it("symmetric", () => {
    fc.assert(fc.property(arbUrl, arbUrl, (a, b) => {
      expect(sameSite(a, b)).toBe(sameSite(b, a));
    }));
  });

  it("total: never throws on arbitrary strings", () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => {
      expect(() => sameSite(a, b)).not.toThrow();
    }));
  });
});
