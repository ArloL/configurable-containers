import { describe, it, expect } from "vitest";
import { registrableDomain, sameSite } from "../../src/psl/same-site";

describe("registrableDomain", () => {
  it("returns eTLD+1 for normal hosts", () => {
    expect(registrableDomain("https://www.reddit.com/x")).toBe("reddit.com");
    expect(registrableDomain("https://bbc.co.uk/")).toBe("bbc.co.uk");
  });

  it("honours the PSL private section", () => {
    expect(registrableDomain("https://foo.github.io/")).toBe("foo.github.io");
    expect(registrableDomain("https://bar.github.io/")).toBe("bar.github.io");
  });

  it("returns null when there is no registrable domain", () => {
    expect(registrableDomain("http://127.0.0.1/")).toBeNull();
    expect(registrableDomain("http://localhost/")).toBeNull();
    expect(registrableDomain("not a url")).toBeNull();
    expect(registrableDomain("about:blank")).toBeNull();
  });
});

describe("sameSite", () => {
  it("isolates different registrable domains under a public suffix (the co.uk trap)", () => {
    expect(sameSite("https://bbc.co.uk/", "https://theguardian.co.uk/")).toBe(false);
  });

  it("keeps continuity within a registrable domain", () => {
    expect(sameSite("https://www.reddit.com/", "https://old.reddit.com/")).toBe(true);
    expect(sameSite("https://a.example.com/", "https://example.com/")).toBe(true);
  });

  it("isolates different private-suffix domains (github.io)", () => {
    expect(sameSite("https://foo.github.io/", "https://bar.github.io/")).toBe(false);
  });

  it("both-null hosts: same host stays, different host isolates", () => {
    expect(sameSite("http://127.0.0.1/x", "http://127.0.0.1/y")).toBe(true);
    expect(sameSite("http://127.0.0.1/", "http://10.0.0.1/")).toBe(false);
    expect(sameSite("http://localhost/a", "http://localhost/b")).toBe(true);
  });

  it("one-null one-real is never the same site", () => {
    expect(sameSite("http://localhost/", "https://example.com/")).toBe(false);
  });

  it("ignores scheme", () => {
    expect(sameSite("http://example.com/", "https://example.com/")).toBe(true);
  });

  it("is total: never throws on junk", () => {
    expect(() => sameSite("not a url", "")).not.toThrow();
    expect(sameSite("not a url", "")).toBe(false);
  });

  it("handles a PSL wildcard + exception (kawasaki.jp)", () => {
    // getDomain(www.city.kawasaki.jp) => city.kawasaki.jp ; getDomain(foo.city.kawasaki.jp) => city.kawasaki.jp
    // The "!city.kawasaki.jp" PSL exception makes city.kawasaki.jp itself registrable,
    // so both hosts share it -> same registrable domain -> sameSite.
    expect(sameSite("https://www.city.kawasaki.jp/", "https://foo.city.kawasaki.jp/")).toBe(true);
    // getDomain(a.kawasaki.jp) => null ; getDomain(b.kawasaki.jp) => null
    // The "*.kawasaki.jp" PSL wildcard makes single-label-under-kawasaki hosts bare public
    // suffixes (no registrable domain). Both-null falls back to exact hostname equality,
    // and the hostnames differ -> not sameSite.
    expect(sameSite("https://a.kawasaki.jp/", "https://b.kawasaki.jp/")).toBe(false);
  });
});
