import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
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
`);

function headers(over: Partial<HeadersDetails> = {}): HeadersDetails {
  return { requestId: "1", tabId: 1, url: "https://seed.example/", type: "main_frame", requestHeaders: [], ...over };
}

describe("cookie-seeder", () => {
  it("seeds the cookie into the tab's own store and rewrites the Cookie header", async () => {
    const mock = createMockPort();
    const tab = mock.addTab({ url: "https://seed.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: mock.port, config, deps: { matchRule } });

    const res = await mock.fireHeaders(headers({ tabId: tab.id }));

    expect(mock.calls.setCookie).toEqual([
      { name: "s", url: "https://seed.example/", value: "1", storeId: "firefox-container-9" },
    ]);
    expect(mock.getStoredCookie("firefox-container-9", "s")).toEqual({ name: "s", value: "1" });
    expect(res).toEqual({ requestHeaders: [{ name: "Cookie", value: "s=1" }] });
  });

  it("merges into an existing Cookie header", async () => {
    const mock = createMockPort();
    const tab = mock.addTab({ url: "https://seed.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: mock.port, config, deps: { matchRule } });

    const res = await mock.fireHeaders(headers({ tabId: tab.id, requestHeaders: [{ name: "Cookie", value: "a=0" }] }));
    expect(res).toEqual({ requestHeaders: [{ name: "Cookie", value: "a=0; s=1" }] });
  });

  it("is a no-op (no setCookie, no response) when no rule matches", async () => {
    const mock = createMockPort();
    const tab = mock.addTab({ url: "https://nomatch.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: mock.port, config, deps: { matchRule } });

    const res = await mock.fireHeaders(headers({ tabId: tab.id, url: "https://nomatch.example/" }));
    expect(mock.calls.setCookie).toEqual([]);
    expect(res).toBeUndefined();
  });

  it("is a no-op for a matched ignore rule", async () => {
    const mock = createMockPort();
    const tab = mock.addTab({ url: "https://pocket.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: mock.port, config, deps: { matchRule } });

    const res = await mock.fireHeaders(headers({ tabId: tab.id, url: "https://pocket.example/" }));
    expect(mock.calls.setCookie).toEqual([]);
    expect(res).toBeUndefined();
  });

  it("still calls setCookie but does NOT rewrite the header when the cookie is already on the wire", async () => {
    const mock = createMockPort();
    const tab = mock.addTab({ url: "https://seed.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: mock.port, config, deps: { matchRule } });

    const res = await mock.fireHeaders(headers({ tabId: tab.id, requestHeaders: [{ name: "Cookie", value: "s=1" }] }));
    expect(mock.calls.setCookie).toHaveLength(1); // TC parity: unconditional set
    expect(res).toBeUndefined(); // header unchanged
  });

  it("ignores non-main_frame requests", async () => {
    const mock = createMockPort();
    const tab = mock.addTab({ url: "https://seed.example/", cookieStoreId: "firefox-container-9" });
    createCookieSeeder({ port: mock.port, config, deps: { matchRule } });

    const res = await mock.fireHeaders(headers({ tabId: tab.id, type: "sub_frame" }));
    expect(mock.calls.setCookie).toEqual([]);
    expect(res).toBeUndefined();
  });

  it("fails open when the tab has raced away", async () => {
    const mock = createMockPort();
    createCookieSeeder({ port: mock.port, config, deps: { matchRule } });
    const res = await mock.fireHeaders(headers({ tabId: 999 })); // no such tab
    expect(mock.calls.setCookie).toEqual([]);
    expect(res).toBeUndefined();
  });
});
