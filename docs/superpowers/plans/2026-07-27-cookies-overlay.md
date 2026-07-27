# Cookies Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed a rule's configured cookies into a tab's own container before the page reads them (F12) and never across the identity boundary (F11) — full parity with Temporary Containers' "Set Cookies" (`cookies.set` **plus** an outgoing `Cookie`-header rewrite).

**Architecture:** A new **`cookie-seeder`** owns one blocking `webRequest.onBeforeSendHeaders` listener, wired at `background.ts` as a **sibling** of the engine and disposer (not nested). A pure `cookiesFor(url, config, matchRule)` decides which cookies apply; the seeder writes them into the tab's own `cookieStoreId` and rewrites the outgoing `Cookie` header. Routing (`resolve`/`engine.ts`) is untouched — a reopened tab re-navigates, so the seeder naturally fires in the final container.

**Tech Stack:** TypeScript (ESM), Vitest, esbuild, Selenium/geckodriver, `@types/firefox-webext-browser`.

**Design spec:** `docs/superpowers/specs/2026-07-27-cookies-overlay-design.md`

## Global Constraints

- **Do not change** `src/resolver/resolve.ts`, `src/engine/engine.ts`, `src/engine/registry.ts`, or `src/engine/disposer.ts`. This slice **adds** an overlay module + a seeder sibling + a port seam; it does not alter routing or disposal.
- **F11 (identity boundary):** every `setCookie` MUST pass `storeId` = the tab's own `cookieStoreId`. There is no config field for `storeId` and no code path reads one store and writes another.
- **F12 (timing):** seeding runs on the **blocking** `onBeforeSendHeaders` (await `setCookie` before releasing the request) **and** rewrites the outgoing `Cookie` header, so the cookie is in the store and on the wire before the server responds.
- **TC parity:** `setCookie` is called **unconditionally** on every matching nav; only the header rewrite is conditional (skipped when the cookie is already on the wire with the same value).
- **Overlay ≠ action:** the overlay fires whenever its rule matches, for any action **except `ignore`** (the parser rejects `cookies` on an `ignore` rule; `cookiesFor` also returns `[]` for a matched `ignore` rule).
- **No manifest change:** `cookies` + `webRequestBlocking` are already in `extensions/cc/manifest.json`.
- **Keep `fileParallelism: false`** (do not touch `vitest.config.ts`).
- **Use CLI long options** (`--run`, `--save-dev`).
- **Commit after every task.** End each commit message body with:
  `Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN`

---

### Task 1: Config types + parser (`CookieSpec`, `Rule.cookies`, validation)

**Files:**
- Modify: `src/resolver/types.ts`
- Modify: `src/config/parse.ts`
- Test: `test/config/parse.cookies.test.ts`
- Test: `test/config/parse.real.test.ts` (add one assertion)

**Interfaces:**
- Produces: `CookieSpec` (in `src/resolver/types.ts`) and `Rule.cookies?: CookieSpec[]`; `parseConfig` now populates `rule.cookies` from the YAML `cookies:` key.

> **Real-config note:** the author's `configurable-containers.config.yaml` (exercised by `parse.real.test.ts`) already carries `cookies:` overlays on `youtube.com` and `woki.de`. Until now the parser allow-listed but **dropped** them; after this task it parses them. They all conform to the validation below (string `name`/`url`/`value`, `secure: true`, `sameSite: lax`), so `parse.real.test.ts` stays green — Step 6 asserts the youtube cookies now parse.

- [ ] **Step 1: Add `CookieSpec` and `Rule.cookies` to the resolver types**

In `src/resolver/types.ts`, add the `CookieSpec` interface just above `Rule` and a `cookies?` field on `Rule`:

```ts
// Overlay: a cookie to seed into the tab's own container (the complete
// browser.cookies.set surface minus storeId — the seeder always forces storeId to
// the tab's own cookieStoreId; see the cookies-overlay design spec §5). resolve()
// ignores this; it is consumed by the cookie-seeder, not the router.
export interface CookieSpec {
  name: string;
  url: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "no_restriction" | "lax" | "strict";
  expirationDate?: number;
  firstPartyDomain?: string;
  partitionKey?: { topLevelSite?: string };
}
```

Then change the `Rule` interface from:

```ts
export interface Rule {
  match: Matcher[]; // normalized to a list (single -> [single])
  action: Action;
  // overlays (cookies/scripts) may exist on the real rule but resolve() ignores them
}
```

to:

```ts
export interface Rule {
  match: Matcher[]; // normalized to a list (single -> [single])
  action: Action;
  cookies?: CookieSpec[]; // overlay; resolve() ignores it (consumed by the cookie-seeder)
  // the `scripts` overlay is a later slice and will add its own field the same way
}
```

- [ ] **Step 2: Write the failing parser test**

Create `test/config/parse.cookies.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/config/parse";

const parse = (yaml: string) => parseConfig(yaml);

describe("parseConfig — cookies overlay", () => {
  it("parses a full cookie entry into rule.cookies", () => {
    const config = parse(`
rules:
  - match: youtube.com
    open: Temporary
    cookies:
      - name: SOCS
        url: "https://www.youtube.com/"
        value: "abc"
        secure: true
        httpOnly: false
        sameSite: lax
        expirationDate: 1893456000
        domain: ".youtube.com"
        path: "/"
        firstPartyDomain: ""
        partitionKey: { topLevelSite: "https://youtube.com" }
`);
    expect(config.rules[0].cookies).toEqual([
      {
        name: "SOCS",
        url: "https://www.youtube.com/",
        value: "abc",
        secure: true,
        httpOnly: false,
        sameSite: "lax",
        expirationDate: 1893456000,
        domain: ".youtube.com",
        path: "/",
        firstPartyDomain: "",
        partitionKey: { topLevelSite: "https://youtube.com" },
      },
    ]);
  });

  it("parses a minimal cookie (name + url only) and multiple entries", () => {
    const config = parse(`
rules:
  - match: youtube.com
    cookies:
      - { name: wide, url: "https://www.youtube.com/" }
      - { name: SOCS, url: "https://www.youtube.com/", value: "x" }
`);
    expect(config.rules[0].cookies).toEqual([
      { name: "wide", url: "https://www.youtube.com/" },
      { name: "SOCS", url: "https://www.youtube.com/", value: "x" },
    ]);
  });

  it("leaves cookies undefined when the key is absent", () => {
    const config = parse(`rules:\n  - match: youtube.com\n`);
    expect(config.rules[0].cookies).toBeUndefined();
  });

  it("rejects cookies on an ignore rule", () => {
    expect(() => parse(`
rules:
  - match: getpocket.com
    ignore: true
    cookies:
      - { name: a, url: "https://getpocket.com/" }
`)).toThrow(/cookies.*not allowed.*ignore/i);
  });

  it("rejects a non-list cookies value", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    cookies: nope\n`)).toThrow(ConfigError);
  });

  it("rejects a cookie missing name or url", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { url: "https://x.com/" }\n`)).toThrow(/\.name is required/);
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { name: a }\n`)).toThrow(/\.url is required/);
  });

  it("rejects unknown keys and wrong-typed fields", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { name: a, url: "https://x.com/", bogus: 1 }\n`)).toThrow(/unknown key "bogus"/);
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { name: a, url: "https://x.com/", secure: "yes" }\n`)).toThrow(/secure must be a boolean/);
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { name: a, url: "https://x.com/", sameSite: whenever }\n`)).toThrow(/sameSite must be one of/);
    expect(() => parse(`rules:\n  - match: x.com\n    cookies:\n      - { name: a, url: "https://x.com/", expirationDate: soon }\n`)).toThrow(/expirationDate must be a number/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest --run test/config/parse.cookies.test.ts`
Expected: FAIL — `cookies` is currently dropped, so `config.rules[0].cookies` is `undefined` and the validation errors don't fire.

- [ ] **Step 4: Implement cookie parsing in `src/config/parse.ts`**

Add the import for `CookieSpec` — change:

```ts
import type { Action, Config, Group, Matcher, Rule } from "../resolver/types";
```

to:

```ts
import type { Action, Config, CookieSpec, Group, Matcher, Rule } from "../resolver/types";
```

Add these constants just below `ALLOWED_RULE_KEYS`:

```ts
const ALLOWED_COOKIE_KEYS = new Set([
  "name", "url", "value", "domain", "path", "secure", "httpOnly",
  "sameSite", "expirationDate", "firstPartyDomain", "partitionKey",
]);
const SAME_SITE = new Set(["no_restriction", "lax", "strict"]);
```

Add these two functions just above `parseRule`:

```ts
function parseCookie(raw: unknown, path: string): CookieSpec {
  if (!isMapping(raw)) throw new ConfigError(`${path} must be a mapping`, { path });
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_COOKIE_KEYS.has(k)) throw new ConfigError(`unknown key "${k}" in ${path}`, { path });
  }

  const spec = {} as CookieSpec;

  for (const key of ["name", "url"] as const) {
    const v = raw[key];
    if (typeof v !== "string" || v === "") {
      throw new ConfigError(`${path}.${key} is required and must be a non-empty string`, { path: `${path}.${key}` });
    }
    spec[key] = v;
  }

  for (const key of ["value", "domain", "path", "firstPartyDomain"] as const) {
    if (key in raw) {
      const v = raw[key];
      if (typeof v !== "string") throw new ConfigError(`${path}.${key} must be a string`, { path: `${path}.${key}` });
      spec[key] = v;
    }
  }

  for (const key of ["secure", "httpOnly"] as const) {
    if (key in raw) {
      const v = raw[key];
      if (typeof v !== "boolean") throw new ConfigError(`${path}.${key} must be a boolean`, { path: `${path}.${key}` });
      spec[key] = v;
    }
  }

  if ("sameSite" in raw) {
    const v = raw.sameSite;
    if (typeof v !== "string" || !SAME_SITE.has(v)) {
      throw new ConfigError(`${path}.sameSite must be one of no_restriction, lax, strict`, { path: `${path}.sameSite` });
    }
    spec.sameSite = v as CookieSpec["sameSite"];
  }

  if ("expirationDate" in raw) {
    const v = raw.expirationDate;
    if (typeof v !== "number") throw new ConfigError(`${path}.expirationDate must be a number`, { path: `${path}.expirationDate` });
    spec.expirationDate = v;
  }

  if ("partitionKey" in raw) {
    const v = raw.partitionKey;
    if (!isMapping(v)) throw new ConfigError(`${path}.partitionKey must be an object`, { path: `${path}.partitionKey` });
    spec.partitionKey = v as CookieSpec["partitionKey"];
  }

  return spec;
}

function parseCookies(raw: unknown, path: string): CookieSpec[] {
  if (!Array.isArray(raw)) throw new ConfigError(`${path}.cookies must be a list`, { path: `${path}.cookies` });
  return raw.map((entry, j) => parseCookie(entry, `${path}.cookies[${j}]`));
}
```

In `parseRule`, change the final return. Replace:

```ts
  return { match: matchers, action };
}
```

with:

```ts
  if ("cookies" in raw) {
    if (action.kind === "ignore") {
      throw new ConfigError(`${path}.cookies is not allowed on an "ignore" rule`, { path: `${path}.cookies` });
    }
    return { match: matchers, action, cookies: parseCookies(raw.cookies, path) };
  }

  return { match: matchers, action };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest --run test/config/parse.cookies.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Assert the real config's cookies now parse, then run the config + resolver suites**

In `test/config/parse.real.test.ts`, add this test inside the `describe(...)` block (it consumes the module-level `ruleForHost` helper already defined there):

```ts
  it("parses the youtube cookie overlays from the real config", () => {
    const cookies = ruleForHost("youtube.com")?.cookies;
    expect(cookies?.map((c) => c.name)).toEqual(["wide", "SOCS"]);
    expect(cookies?.[1]).toMatchObject({ name: "SOCS", secure: true, sameSite: "lax" });
  });
```

Run: `npx vitest --run test/config test/resolver`
Expected: PASS. (The `Rule.cookies?` field is optional; existing tests that build/compare rules without it are unaffected. The real config's previously-dropped `cookies` now parse without error; its `scripts` key remains allow-listed and ignored — a later slice.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/resolver/types.ts src/config/parse.ts test/config/parse.cookies.test.ts
git commit -m "feat(config): parse + validate the cookies overlay into Rule.cookies

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 2: Pure overlay core (`cookiesFor` + header helpers)

**Files:**
- Create: `src/overlays/cookies.ts`
- Test: `test/overlays/cookies.test.ts`

**Interfaces:**
- Consumes: `Config`, `CookieSpec`, `Deps` from `src/resolver/types`; `HttpHeader` (type only) from `src/engine/port` — added in Task 3, but this task uses only a minimal local shape, see below.
- Produces:
  - `cookiesFor(url: string, config: Config, matchRule: Deps["matchRule"]): CookieSpec[]`
  - `parseCookieHeader(headers: HttpHeader[]): Record<string, string>`
  - `writeCookieHeader(headers: HttpHeader[], jar: Record<string, string>): HttpHeader[]`

> **Note on `HttpHeader`:** the header helpers operate on `{ name: string; value?: string }`. To avoid a task-ordering dependency, this module declares and exports its own `HttpHeader` type; Task 3 imports *this* one into `port.ts` (single definition, re-exported), so there is no duplicate.

- [ ] **Step 1: Write the failing test**

Create `test/overlays/cookies.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --run test/overlays/cookies.test.ts`
Expected: FAIL — cannot resolve `../../src/overlays/cookies`.

- [ ] **Step 3: Implement `src/overlays/cookies.ts`**

```ts
// Pure overlay core: which cookies apply to a URL, and Cookie-header (de)serialization.
// No browser, no I/O. Consumed by the cookie-seeder (src/engine/cookie-seeder.ts).
import type { Config, CookieSpec, Deps } from "../resolver/types";

// A single HTTP request/response header. Re-exported from src/engine/port.ts so the
// port seam and this pure module share one definition.
export interface HttpHeader {
  name: string;
  value?: string;
}

// The cookies to seed for `url`: the first matching rule's overlay, or [] when no
// rule matches or the matched rule is `ignore`. Routed through the SAME injected
// matchRule as the router, so overlay precedence can never drift from routing.
export function cookiesFor(url: string, config: Config, matchRule: Deps["matchRule"]): CookieSpec[] {
  const rule = matchRule(url, config.rules);
  if (!rule || rule.action.kind === "ignore") return [];
  return rule.cookies ?? [];
}

// Parse a request's `Cookie` header into a { name: value } jar (empty if absent).
export function parseCookieHeader(headers: HttpHeader[]): Record<string, string> {
  const jar: Record<string, string> = {};
  const header = headers.find((h) => h.name.toLowerCase() === "cookie");
  if (!header?.value) return jar;
  for (const part of header.value.split("; ")) {
    const eq = part.indexOf("=");
    if (eq > 0) jar[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return jar;
}

// Return a new header array with the `Cookie` header rebuilt from the jar (any
// existing Cookie header, whatever its casing, is dropped and one canonical
// `Cookie` header appended).
export function writeCookieHeader(headers: HttpHeader[], jar: Record<string, string>): HttpHeader[] {
  const value = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const out = headers.filter((h) => h.name.toLowerCase() !== "cookie");
  out.push({ name: "Cookie", value });
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --run test/overlays/cookies.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/overlays/cookies.ts test/overlays/cookies.test.ts
git commit -m "feat(overlays): pure cookiesFor + Cookie-header (de)serialization

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 3: Port seam — `onBeforeSendHeaders`, `setCookie`, `getCookie`

**Files:**
- Modify: `src/engine/port.ts`
- Modify: `src/engine/browser-port.ts`
- Modify: `test/engine/mock-port.ts`
- Test: `test/engine/browser-port.test.ts`

**Interfaces:**
- Consumes: `HttpHeader` from `src/overlays/cookies` (Task 2).
- Produces (on `BrowserPort`):
  - `onBeforeSendHeaders(handler: (d: HeadersDetails) => Promise<BlockingHeadersResponse | void>): void`
  - `setCookie(details: SetCookieDetails): Promise<void>`
  - `getCookie(details: GetCookieDetails): Promise<Cookie | null>`
- Produces types in `port.ts`: `HeadersDetails`, `BlockingHeadersResponse`, `SetCookieDetails`, `GetCookieDetails`, `Cookie`, and a re-export of `HttpHeader`.
- Produces on the mock (`test/engine/mock-port.ts`): `fireHeaders(d)`, `calls.setCookie`, `getStoredCookie(storeId, name)`.

- [ ] **Step 1: Add the seam types + methods to `src/engine/port.ts`**

At the top of `src/engine/port.ts`, add an import + re-export of `HttpHeader` (single source of truth is the pure module):

```ts
import type { HttpHeader } from "../overlays/cookies";
export type { HttpHeader };
```

Add these interfaces after `WebRequestDetails`:

```ts
export interface HeadersDetails {
  requestId: string;
  tabId: number;
  url: string;
  type: "main_frame" | "sub_frame" | string;
  requestHeaders: HttpHeader[]; // present because the listener asks for "requestHeaders"
}

export interface BlockingHeadersResponse {
  requestHeaders?: HttpHeader[]; // returned to apply header edits
}

// The browser.cookies.set surface (complete minus nothing) — storeId is REQUIRED and
// the seeder always sets it to the tab's own store (F11). Mirrors CookieSpec + storeId.
export interface SetCookieDetails {
  url: string;
  name: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "no_restriction" | "lax" | "strict";
  expirationDate?: number;
  firstPartyDomain?: string;
  partitionKey?: { topLevelSite?: string };
  storeId: string;
}

export interface GetCookieDetails {
  url: string;
  name: string;
  storeId: string;
  firstPartyDomain?: string;
  partitionKey?: { topLevelSite?: string };
}

export interface Cookie {
  name: string;
  value: string;
}
```

Add the three methods to the `BrowserPort` interface (after `sendExternalMessage`, alongside the F10 block):

```ts
  // Cookies overlay — a blocking main_frame onBeforeSendHeaders listener plus
  // cookie read/write. The seeder seeds into the tab's OWN store and rewrites the
  // outgoing Cookie header (F11/F12).
  onBeforeSendHeaders(
    handler: (d: HeadersDetails) => Promise<BlockingHeadersResponse | void>
  ): void;
  setCookie(details: SetCookieDetails): Promise<void>;
  getCookie(details: GetCookieDetails): Promise<Cookie | null>;
```

- [ ] **Step 2: Write the failing adapter test (extend `test/engine/browser-port.test.ts`)**

First extend the `fakeBrowser()` factory in `test/engine/browser-port.test.ts`. Add a `webRequest.onBeforeSendHeaders` block and a `cookies` block. Inside the returned object, add alongside `webRequest.onBeforeRequest`:

```ts
      onBeforeSendHeaders: {
        addListener(fn: (d: unknown) => unknown, filter: unknown, extra: unknown) {
          f.webRequest.onBeforeSendHeaders.onBeforeSendHeaders_last = { fn, filter, extra };
        },
        onBeforeSendHeaders_last: null as unknown,
      },
```

and add a top-level `cookies` block alongside `contextualIdentities`:

```ts
    cookies: {
      set: async (d: Record<string, unknown>) => {
        f.cookies._set = d;
        return { name: d.name, value: d.value ?? "" };
      },
      get: async (d: { name: string; storeId: string }) => {
        if (d.name === "absent") return null;
        return { name: d.name, value: "V", storeId: d.storeId };
      },
      _set: null as unknown,
    },
```

Then add these test cases inside the `describe("createBrowserPort", ...)` block:

```ts
  it("registers a blocking main_frame onBeforeSendHeaders listener and maps details", async () => {
    const port = createBrowserPort();
    let seen: unknown;
    port.onBeforeSendHeaders(async (d) => { seen = d; return { requestHeaders: d.requestHeaders }; });

    const reg = f.webRequest.onBeforeSendHeaders.onBeforeSendHeaders_last as { fn: (d: unknown) => Promise<unknown>; filter: unknown; extra: unknown };
    expect(reg.filter).toEqual({ urls: ["<all_urls>"], types: ["main_frame"] });
    expect(reg.extra).toEqual(["blocking", "requestHeaders"]);

    const result = await reg.fn({ requestId: "7", tabId: 2, url: "https://a.test/", type: "main_frame", requestHeaders: [{ name: "Cookie", value: "a=1" }] });
    expect(seen).toMatchObject({ requestId: "7", tabId: 2, url: "https://a.test/", type: "main_frame", requestHeaders: [{ name: "Cookie", value: "a=1" }] });
    expect(result).toEqual({ requestHeaders: [{ name: "Cookie", value: "a=1" }] });
  });

  it("coerces a void onBeforeSendHeaders result to an empty response", async () => {
    const port = createBrowserPort();
    port.onBeforeSendHeaders(async () => undefined);
    const reg = f.webRequest.onBeforeSendHeaders.onBeforeSendHeaders_last as { fn: (d: unknown) => Promise<unknown> };
    expect(await reg.fn({ requestId: "1", tabId: 1, url: "https://a.test/", type: "main_frame", requestHeaders: [] })).toEqual({});
  });

  it("setCookie delegates to browser.cookies.set with the storeId", async () => {
    const port = createBrowserPort();
    await port.setCookie({ name: "s", url: "https://a.test/", value: "1", storeId: "firefox-container-2" });
    expect(f.cookies._set).toMatchObject({ name: "s", url: "https://a.test/", value: "1", storeId: "firefox-container-2" });
  });

  it("getCookie maps a hit and returns null for a miss", async () => {
    const port = createBrowserPort();
    expect(await port.getCookie({ name: "s", url: "https://a.test/", storeId: "firefox-container-2" })).toEqual({ name: "s", value: "V" });
    expect(await port.getCookie({ name: "absent", url: "https://a.test/", storeId: "firefox-container-2" })).toBeNull();
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest --run test/engine/browser-port.test.ts`
Expected: FAIL — `port.onBeforeSendHeaders`/`setCookie`/`getCookie` are not implemented.

- [ ] **Step 4: Implement the three methods in `src/engine/browser-port.ts`**

Add them inside the object returned by `createBrowserPort()` (after `removeIdentity`):

```ts
    onBeforeSendHeaders(handler) {
      browser.webRequest.onBeforeSendHeaders.addListener(
        (d) =>
          handler({
            requestId: d.requestId, tabId: d.tabId, url: d.url, type: d.type,
            requestHeaders: d.requestHeaders ?? [],
          }).then((r) => r ?? {}), // void -> empty response (proceed)
        { urls: ["<all_urls>"], types: ["main_frame"] },
        ["blocking", "requestHeaders"]
      );
    },

    async setCookie(details) {
      await browser.cookies.set(details);
    },

    async getCookie(details) {
      const c = await browser.cookies.get(details);
      return c ? { name: c.name, value: c.value } : null;
    },
```

> **Typecheck note:** `details` is our `SetCookieDetails`/`GetCookieDetails`; it is passed straight to `browser.cookies.set`/`get`. Extra optional source properties (e.g. `partitionKey` if the pinned `@types` predates it) remain assignable — do **not** cast. If tsc flags a *shared* field's type (e.g. `sameSite`), align our union to the `@types` `cookies.SameSiteStatus` values rather than casting.

- [ ] **Step 5: Implement the three methods in the mock (`test/engine/mock-port.ts`)**

Add the new type imports to the existing `import type { … } from "../../src/engine/port"` block:

```ts
  BlockingHeadersResponse,
  Cookie,
  GetCookieDetails,
  HeadersDetails,
  SetCookieDetails,
```

Add to the `MockPort` interface (after `calls`):

```ts
  fireHeaders(d: HeadersDetails): Promise<BlockingHeadersResponse | void>;
  getStoredCookie(storeId: string, name: string): Cookie | null;
```

and add `setCookie` to the `calls` shape in both the interface and the object literal:

```ts
    setCookie: SetCookieDetails[];
```

Inside `createMockPort()`, add state near the other `let`s:

```ts
  let headersHandler: ((d: HeadersDetails) => Promise<BlockingHeadersResponse | void>) | null = null;
  const cookieStore = new Map<string, Map<string, Cookie>>(); // storeId -> name -> cookie
```

add `setCookie: []` to the `calls` object literal, then add these three methods to the `port` object:

```ts
    onBeforeSendHeaders(h) {
      headersHandler = h;
    },
    async setCookie(details) {
      calls.setCookie.push(details);
      const jar = cookieStore.get(details.storeId) ?? new Map<string, Cookie>();
      jar.set(details.name, { name: details.name, value: details.value ?? "" });
      cookieStore.set(details.storeId, jar);
    },
    async getCookie(details) {
      return cookieStore.get(details.storeId)?.get(details.name) ?? null;
    },
```

and expose the two test helpers in the returned object (after `setCreateTabThrows`):

```ts
    async fireHeaders(d) {
      if (!headersHandler) throw new Error("no onBeforeSendHeaders handler registered");
      return headersHandler(d);
    },
    getStoredCookie: (storeId, name) => cookieStore.get(storeId)?.get(name) ?? null,
```

- [ ] **Step 6: Run the adapter test + typecheck**

Run: `npx vitest --run test/engine/browser-port.test.ts`
Expected: PASS (original 6 + 4 new = 10 tests).

Run: `npm run typecheck`
Expected: no errors. (The mock now satisfies the widened `BrowserPort`; the existing engine/disposer tests that build a mock are unaffected.)

- [ ] **Step 7: Run the engine + disposer suites (no regression)**

Run: `npx vitest --run test/engine`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/engine/port.ts src/engine/browser-port.ts test/engine/mock-port.ts test/engine/browser-port.test.ts
git commit -m "feat(engine): port seam for onBeforeSendHeaders + cookie set/get

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 4: The cookie-seeder (L3)

**Files:**
- Create: `src/engine/cookie-seeder.ts`
- Test: `test/engine/cookie-seeder.test.ts`

**Interfaces:**
- Consumes: `BrowserPort`, `HeadersDetails` from `src/engine/port`; `Config`, `Deps` from `src/resolver/types`; `cookiesFor`, `parseCookieHeader`, `writeCookieHeader` from `src/overlays/cookies`.
- Produces: `createCookieSeeder(opts: CookieSeederOptions): void` where `CookieSeederOptions = { port: BrowserPort; config: Config; deps: Pick<Deps, "matchRule"> }`.

- [ ] **Step 1: Write the failing test**

Create `test/engine/cookie-seeder.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --run test/engine/cookie-seeder.test.ts`
Expected: FAIL — cannot resolve `../../src/engine/cookie-seeder`.

- [ ] **Step 3: Implement `src/engine/cookie-seeder.ts`**

```ts
import type { Config, Deps } from "../resolver/types";
import type { BrowserPort } from "./port";
import { cookiesFor, parseCookieHeader, writeCookieHeader } from "../overlays/cookies";

export interface CookieSeederOptions {
  port: BrowserPort;
  config: Config;
  deps: Pick<Deps, "matchRule">;
}

// A sibling of the engine and disposer (wired at background.ts, not nested). Owns one
// blocking main_frame onBeforeSendHeaders listener. Mirrors TCP's maybeSetAndAddToHeader:
// set each configured cookie into the tab's OWN store (F11) and, if it isn't already on
// the wire, splice it into the outgoing Cookie header (F12). Never routes/moves a tab.
export function createCookieSeeder(opts: CookieSeederOptions): void {
  const { port, config, deps } = opts;

  port.onBeforeSendHeaders(async (d) => {
    if (d.type !== "main_frame") return;

    const specs = cookiesFor(d.url, config, deps.matchRule);
    if (specs.length === 0) return; // pure early-out — the common case, before any await

    const tab = await port.getTab(d.tabId);
    if (!tab) return; // tab raced away — fail open

    const store = tab.cookieStoreId;
    const jar = parseCookieHeader(d.requestHeaders);
    let changed = false;

    for (const c of specs) {
      await port.setCookie({ ...c, storeId: store }); // unconditional (TC parity), into the tab's own store
      if (jar[c.name] === (c.value ?? "")) continue; // already on the wire with this value
      const got = await port.getCookie({ name: c.name, url: d.url, storeId: store });
      if (got) {
        jar[got.name] = got.value;
        changed = true;
      }
    }

    if (!changed) return;
    return { requestHeaders: writeCookieHeader(d.requestHeaders, jar) };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --run test/engine/cookie-seeder.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/cookie-seeder.ts test/engine/cookie-seeder.test.ts
git commit -m "feat(engine): cookie-seeder — TC-parity seeding on onBeforeSendHeaders

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 5: Wire the seeder into the extension + bundled cookie rule

**Files:**
- Modify: `src/extension/background.ts`
- Modify: `src/extension/config.ts`
- Modify: `test/extension/config.test.ts`

**Interfaces:**
- Consumes: `createCookieSeeder` from `src/engine/cookie-seeder`; `matchRule` from `src/matcher/matcher`.

- [ ] **Step 1: Add a cookie overlay to the bundled config**

In `src/extension/config.ts`, change `BUNDLED_CONFIG_YAML` from:

```ts
export const BUNDLED_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
`;
```

to:

```ts
export const BUNDLED_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
    cookies:
      - { name: seed, url: "http://work.example/", value: "1" }
`;
```

- [ ] **Step 2: Extend the bundled-config test**

In `test/extension/config.test.ts`, add this test inside the `describe("bundled extension config", …)` block:

```ts
  it("carries the seed cookie overlay on the work.example rule", () => {
    const config = parseConfig(BUNDLED_CONFIG_YAML);
    const rule = matchRule("https://work.example/", config.rules);
    expect(rule!.cookies).toEqual([{ name: "seed", url: "http://work.example/", value: "1" }]);
  });
```

- [ ] **Step 3: Run the config test**

Run: `npx vitest --run test/extension/config.test.ts`
Expected: PASS (3 tests — the two existing `action`/no-match tests still pass; the new cookie test passes).

- [ ] **Step 4: Wire the seeder in `src/extension/background.ts`**

Replace the whole file with (parse the config once, pass it to engine and seeder):

```ts
import { createEngine } from "../engine/engine";
import { createDisposer } from "../engine/disposer";
import { createCookieSeeder } from "../engine/cookie-seeder";
import { createBrowserPort, realClock } from "../engine/browser-port";
import { parseConfig } from "../config/parse";
import { matchRule, matchGroup } from "../matcher/matcher";
import { sameSite } from "../psl/same-site";
import { BUNDLED_CONFIG_YAML } from "./config";

// Injected at bundle time by esbuild (harness/build-extension.ts).
declare const __CC_GRACE_MS__: number;

const port = createBrowserPort();
const config = parseConfig(BUNDLED_CONFIG_YAML);

createEngine({
  port,
  config,
  deps: { matchRule, matchGroup, sameSite },
  onChoice: () => {}, // no picker UI in this slice; the bundled config has no choice rule
});

createDisposer({ port, clock: realClock, graceMs: __CC_GRACE_MS__ });

createCookieSeeder({ port, config, deps: { matchRule } });
```

- [ ] **Step 5: Typecheck (covers the background wiring)**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/extension/background.ts src/extension/config.ts test/extension/config.test.ts
git commit -m "feat(extension): wire cookie-seeder + seed cookie in bundled config

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 6: Harness — server Cookie-echo + probe cross-store cookie reporter

**Files:**
- Modify: `harness/server.ts`
- Modify: `extensions/probe/background.js`
- Modify: `harness/firefox.ts`
- Test: `test/harness/server.test.ts` (add one case)

**Interfaces:**
- Produces (from `harness/firefox.ts`):
  - `readSeenCookie(driver: WebDriver): Promise<string>` — the `Cookie` header the server received.
  - `readCookieNamesHere(driver: WebDriver): Promise<string[]>` — cookie names visible in the tab's own store for its URL.
  - `readCookieNamesDefault(driver: WebDriver): Promise<string[]>` — the same query against `firefox-default`.

- [ ] **Step 1: Echo the incoming Cookie header from the test server**

Replace `harness/server.ts` with:

```ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Escape a string for safe inclusion in a double-quoted HTML attribute.
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const server = createServer((req, res) => {
    // Reflect the request's Cookie header into a body attribute so an external driver
    // can assert the FIRST request already carried a seeded cookie (F12 wire side).
    const cookie = req.headers.cookie ?? "";
    const html =
      "<!doctype html><html><head><title>probe-target</title></head>" +
      `<body data-seen-cookie="${escapeAttr(cookie)}">ok</body></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
```

- [ ] **Step 2: Add a server test for the Cookie echo**

In `test/harness/server.test.ts`, add this test inside the `describe("startServer", …)` block:

```ts
  it("reflects the request Cookie header into a body attribute", async () => {
    const server = await startServer();
    try {
      const res = await fetch(server.url, { headers: { cookie: "seed=1" } });
      const body = await res.text();
      expect(body).toContain('data-seen-cookie="seed=1"');
    } finally {
      await server.close();
    }
  });
```

- [ ] **Step 3: Run the server test (still green + new case)**

Run: `npx vitest --run test/harness/server.test.ts`
Expected: PASS (2 tests — the existing title/close test and the new echo test).

- [ ] **Step 4: Extend the probe to report cookie names per store**

In `extensions/probe/background.js`, add a `cookieNames` helper above `reportTab`:

```js
// Names of cookies that would be sent to `url` in `storeId` (getAll sees httpOnly too).
async function cookieNames(url, storeId) {
  try {
    const cs = await browser.cookies.getAll({ url, storeId });
    return cs.map((c) => c.name).join(",");
  } catch (_e) {
    return "";
  }
}
```

Replace `reportTab` to take the URL and also write the two cookie-name attributes:

```js
async function reportTab(tabId, cookieStoreId, url) {
  let name = "";
  try {
    name = (await browser.contextualIdentities.get(cookieStoreId)).name;
  } catch (_e) {
    // firefox-default has no identity — leave name empty.
  }
  let list = "";
  try {
    list = (await browser.contextualIdentities.query({})).map((c) => c.name).join(",");
  } catch (_e) {
    // ignore
  }
  const here = await cookieNames(url, cookieStoreId);
  const def = await cookieNames(url, "firefox-default");
  try {
    await browser.tabs.executeScript(tabId, {
      code:
        "document.title = " + JSON.stringify(REPORT_PREFIX + cookieStoreId) + ";" +
        "document.documentElement.setAttribute('data-cc-container', " + JSON.stringify(name) + ");" +
        "document.documentElement.setAttribute('data-cc-containers', " + JSON.stringify(list) + ");" +
        "document.documentElement.setAttribute('data-cc-cookies-here', " + JSON.stringify(here) + ");" +
        "document.documentElement.setAttribute('data-cc-cookies-default', " + JSON.stringify(def) + ");",
    });
  } catch (_e) {
    // about:, view-source:, moz-extension: pages cannot be injected — ignore.
  }
}
```

Update the `onUpdated` listener to pass `tab.url`:

```js
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && /^https?:/.test(tab.url || "")) {
    reportTab(tabId, tab.cookieStoreId, tab.url);
  }
});
```

(The probe manifest already grants `cookies` — no manifest change.)

- [ ] **Step 5: Add the driver read helpers to `harness/firefox.ts`**

After `readContainerList`, add:

```ts
// The Cookie header the server received (F12 wire side), reflected into the body.
export async function readSeenCookie(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.body.getAttribute('data-seen-cookie') || '';"
  )) as string;
}

// Cookie names visible in the tab's OWN store for its URL (probe getAll).
export async function readCookieNamesHere(driver: WebDriver): Promise<string[]> {
  const raw = (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-cookies-here') || '';"
  )) as string;
  return raw ? raw.split(",") : [];
}

// Cookie names visible in the DEFAULT store for the tab's URL — the F11 counter-check.
export async function readCookieNamesDefault(driver: WebDriver): Promise<string[]> {
  const raw = (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-cookies-default') || '';"
  )) as string;
  return raw ? raw.split(",") : [];
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Verify no plumbing/routing regression (needs Firefox + geckodriver)**

Run: `npx vitest --run test/e2e/plumbing.test.ts test/e2e/routing.test.ts`
Expected: PASS. The probe change adds attributes but keeps the `CSID:` title and container attributes unchanged, so plumbing/routing assertions are unaffected. If geckodriver is unavailable locally, note it and defer to CI.

- [ ] **Step 8: Commit**

```bash
git add harness/server.ts harness/firefox.ts extensions/probe/background.js test/harness/server.test.ts
git commit -m "feat(harness): server Cookie echo + probe cross-store cookie reporter

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 7: L4 real-Firefox e2e (F11 boundary + F12 first-request)

**Files:**
- Test: `test/e2e/cookies.test.ts`

**Interfaces:**
- Consumes: `launch`, `awaitContainerTab`, `readCookieNamesHere`, `readCookieNamesDefault`, `readSeenCookie`, `type Session` from `harness/firefox`.

- [ ] **Step 1: Write the e2e test**

Create `test/e2e/cookies.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitContainerTab, readCookieNamesHere, readCookieNamesDefault, readSeenCookie, type Session,
} from "../../harness/firefox";

describe("cookies overlay (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  // Open a fresh firefox-default tab and navigate it; CC cancels + reopens into Work,
  // tearing down the original tab mid-nav — tolerate that.
  async function navFreshTab(url: string) {
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("seeds the cookie into the routed container, not the default store, and onto the first request", async () => {
    const url = `http://work.example:${port}/`;
    await navFreshTab(url);

    // The routed Work tab (awaitContainerTab leaves the driver focused on it).
    const { name } = await awaitContainerTab(session.driver, url);
    expect(name).toBe("Work");

    // F11 boundary: present in this container's store for this URL, absent from default.
    expect(await readCookieNamesHere(session.driver)).toContain("seed");
    expect(await readCookieNamesDefault(session.driver)).not.toContain("seed");

    // F12 wire side: the very first request into the Work container already carried it.
    expect(await readSeenCookie(session.driver)).toContain("seed=1");
  });
});
```

- [ ] **Step 2: Run the L4 test**

Run: `npx vitest --run test/e2e/cookies.test.ts`
Expected: PASS (1 test). It launches real Firefox with CC + probe. If it fails, debug against the spec §9 risks: confirm `network.dns.localDomains` resolves `work.example`; confirm the blocking `onBeforeSendHeaders` actually rewrites the header (widen `awaitContainerTab` if headless startup is slow); confirm the probe's `getAll` uses the same URL the tab is on. Do **not** weaken the assertions to make it pass.

- [ ] **Step 3: Run the full suite (regression)**

Run: `npx vitest --run`
Expected: all suites pass — unit (config, overlays, engine, matcher, psl, resolver), extension unit, and the e2e (plumbing, routing, disposal, cookies).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/cookies.test.ts
git commit -m "test(e2e): L4 cookies overlay — seeded into container not default; on first request

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

## Self-review notes (author)

- **Spec coverage:** §1 module/scope → Tasks 2,4,5; §2 sibling seeder on blocking `onBeforeSendHeaders` → Tasks 3,4,5; §3 pure core (`cookiesFor` + header helpers) → Task 2; §4 TC-parity algorithm (unconditional set, conditional header) → Task 4 (+ the "already on the wire" test); §5 `CookieSpec` full field surface + `Rule.cookies` + parser validation incl. `cookies`-on-`ignore` → Task 1; §6 port seam (`onBeforeSendHeaders`/`setCookie`/`getCookie` + detail types) → Task 3; §7 wiring (parse once, sibling) → Task 5; §8 testing (pure, config, L3 seeder, L4 F11+F12) → Tasks 1,2,4,7; §9 risks (blocking timing, structural F11, cheap early-out, no precedence drift) → Tasks 4,7. No spec section is unmapped.
- **F11 at L4 — mechanism:** the same-URL present-in-container / absent-in-default check (Task 7 via the probe's `getAll` against both stores) is the concrete realization of the spec §8 "absent in a different container" claim. CC deterministically maps `work.example → Work`, so the boundary is proven by querying the two stores for the *same* URL rather than by navigating the same host into two containers (which routing makes impossible).
- **Type consistency:** `CookieSpec` (Task 1) ⊂ `SetCookieDetails` (Task 3, adds required `storeId`), so `{ ...spec, storeId }` in the seeder (Task 4) is structurally a `SetCookieDetails`. `HttpHeader` is defined once in `src/overlays/cookies.ts` (Task 2) and re-exported from `port.ts` (Task 3). `cookiesFor`, `parseCookieHeader`, `writeCookieHeader`, `createCookieSeeder`, `readSeenCookie`, `readCookieNamesHere`, `readCookieNamesDefault` are named identically across the tasks that define and consume them.
- **No placeholders:** every code and test step shows complete content; no "similar to Task N" references.
```
