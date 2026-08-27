import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { createCookieSeeder } from "../../src/engine/cookie-seeder";
import { parseConfig } from "../../src/config/parse";
import { matchRule } from "../../src/matcher/matcher";
import type { HeadersDetails } from "../../src/engine/port";

const config = parseConfig(`
rules:
  - match: seed.example
    open: Work
    cookies:
      - { name: s, url: "https://seed.example/", value: "1" }
  - match: pocket.example
    ignore: true
  - match: flag.example
    open: Work
    cookies:
      - { name: f, url: "https://flag.example/" }
      - { name: sec, url: "https://flag.example/", value: "1", secure: true }
`);

function headers(over: Partial<HeadersDetails> = {}): HeadersDetails {
  return { requestId: "1", tabId: 1, url: "https://seed.example/", type: "main_frame", requestHeaders: [], ...over };
}

describe("cookie-seeder", () => {
  it("seeds the cookie into the tab's own store and rewrites the Cookie header", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://seed.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: browser.port, config, deps: { matchRule } });

    const blockingResponse = await browser.sendsHeaders(headers({ tabId: tab.id }));

    expect(browser.seededCookies).toEqual([
      { name: "s", url: "https://seed.example/", value: "1", storeId: "firefox-container-9" },
    ]);
    expect(browser.cookieIn("firefox-container-9", "s")).toEqual({ name: "s", value: "1" });
    expect(blockingResponse).toEqual({ requestHeaders: [{ name: "Cookie", value: "s=1" }] });
  });

  it("merges into an existing Cookie header", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://seed.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: browser.port, config, deps: { matchRule } });

    const blockingResponse = await browser.sendsHeaders(headers({ tabId: tab.id, requestHeaders: [{ name: "Cookie", value: "a=0" }] }));
    expect(blockingResponse).toEqual({ requestHeaders: [{ name: "Cookie", value: "a=0; s=1" }] });
  });

  it("is a no-op (no setCookie, no response) when no rule matches", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://nomatch.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: browser.port, config, deps: { matchRule } });

    const blockingResponse = await browser.sendsHeaders(headers({ tabId: tab.id, url: "https://nomatch.example/" }));
    expect(browser.seededCookies).toEqual([]);
    expect(blockingResponse).toBeUndefined();
  });

  it("is a no-op for a matched ignore rule", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://pocket.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: browser.port, config, deps: { matchRule } });

    const blockingResponse = await browser.sendsHeaders(headers({ tabId: tab.id, url: "https://pocket.example/" }));
    expect(browser.seededCookies).toEqual([]);
    expect(blockingResponse).toBeUndefined();
  });

  it("still calls setCookie but does NOT rewrite the header when the cookie is already on the wire", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://seed.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: browser.port, config, deps: { matchRule } });

    const blockingResponse = await browser.sendsHeaders(headers({ tabId: tab.id, requestHeaders: [{ name: "Cookie", value: "s=1" }] }));
    expect(browser.seededCookies).toHaveLength(1); // TC parity: unconditional set
    expect(blockingResponse).toBeUndefined(); // header unchanged
  });

  it("ignores non-main_frame requests", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://seed.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: browser.port, config, deps: { matchRule } });

    const blockingResponse = await browser.sendsHeaders(headers({ tabId: tab.id, type: "sub_frame" }));
    expect(browser.seededCookies).toEqual([]);
    expect(blockingResponse).toBeUndefined();
  });

  it("fails open when the tab has raced away", async () => {
    const browser = aFakeBrowser();
    createCookieSeeder({ port: browser.port, config, deps: { matchRule } });
    const blockingResponse = await browser.sendsHeaders(headers({ tabId: 999 })); // no such tab
    expect(browser.seededCookies).toEqual([]);
    expect(blockingResponse).toBeUndefined();
  });
});

describe("cookie-seeder — a set that the browser will not hand back", () => {
  it("splices only the cookies the request's own url can carry", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "http://flag.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: browser.port, config, deps: { matchRule } });

    const blockingResponse = await browser.sendsHeaders(
      headers({ tabId: tab.id, url: "http://flag.example/" }),
    );

    // Both are set — the spec names its own https url and TC sets unconditionally — but the
    // Secure one is not readable for an http navigation, and a header claiming otherwise
    // sends a cookie the browser itself would have withheld. A valueless cookie is still
    // a cookie: `f=` is what the site's own `document.cookie = "f="` writes.
    expect(browser.seededCookies.map((c) => c.name)).toEqual(["f", "sec"]);
    expect(blockingResponse).toEqual({ requestHeaders: [{ name: "Cookie", value: "f=" }] });
  });
});
