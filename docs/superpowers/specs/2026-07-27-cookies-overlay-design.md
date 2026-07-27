# Cookies Overlay — Design

**Date:** 2026-07-27
**Status:** Approved, pending implementation plan
**Topic:** Seed a rule's configured cookies into a tab's own container so they exist
before the page reads them (F12) and never cross the identity boundary (F11).
Full parity with Temporary Containers' "Set Cookies" feature — `cookies.set` **plus**
an outgoing `Cookie`-header rewrite — modeled on `tcp/src/background/cookies.ts`.
Proven pure/at L3 (mock `browser.*`) and confirmed once in real Firefox (L4).

## 1. Goal & scope

CONFIG.md's `cookies` overlay lets a rule ensure named cookies exist when its domain
loads — to pre-dismiss a consent banner (`SOCS`) or set a UI pref (YouTube `wide`) —
before the page's JavaScript can read them. Today the config parser **allow-lists the
`cookies` key but silently drops it** (`ALLOWED_RULE_KEYS` in `src/config/parse.ts`
includes it, but `parseRule` never reads it), the `Rule` type has no field for it, and
the engine has no seeding step. This slice implements the overlay end to end.

The overlay is **not a routing action**: it never decides a tab's container or
lifecycle. It applies a within-container side-effect *after* routing has already put
the tab wherever it belongs. It fires whenever its rule matches, whatever the rule's
action resolved to (`open` / `inherit` / `redirector` / auto-name), **except `ignore`**
— there the engine does nothing at all.

### In scope

- A new **`cookie-seeder`** module (`src/engine/cookie-seeder.ts`), a sibling of the
  engine and disposer, wired at the extension entry (`background.ts`).
- A pure **`cookiesFor(url, config)`** overlay-matching function plus two pure
  header helpers (`parseCookieHeader` / `writeCookieHeader`).
- Config-parser + type changes: a `CookieSpec` type, `Rule.cookies?`, and real parsing
  + validation of the `cookies` key (including rejecting it on an `ignore` rule).
- `BrowserPort` additions: `onBeforeSendHeaders`, `setCookie`, `getCookie` (+ the
  request/cookie detail types).
- Tests down the pyramid: pure (`cookiesFor`, header round-trip), config-parse
  validation, L3 seeder against the mock port, one L4 real-Firefox F11/F12
  confirmation.

### Out of scope (deferred)

- **The `scripts` overlay** — a sibling slice. It shares the "overlay fires whenever
  the rule matches, `ignore` excepted" model but a different delivery channel
  (`userScripts` at `document_start`), so it is designed and built separately.
- **Match patterns / regex in `match`** — the parser still accepts bare hostnames only
  (unchanged); a `cookies` rule's `match` is bare-host like every other rule today.
- **Absent-only seeding** — rejected in favour of TC parity; see §4.

## 2. Architecture & model

A new **`cookie-seeder`** owns cookie seeding. It makes no routing decisions and never
opens, moves, or closes a tab — it only writes cookies into whatever container a tab is
already in. Like the disposer, it is a **sibling** of the interception engine: both are
wired at `background.ts`, not nested, so `engine.ts` and `resolve()` stay untouched and
seeding is tested independently of routing.

The seeder owns **one blocking `webRequest.onBeforeSendHeaders` listener**
(`{ urls: ['<all_urls>'], types: ['main_frame'] }, ['blocking', 'requestHeaders']`).
`onBeforeSendHeaders` is the event where the outgoing request headers are assembled and
editable — `onBeforeRequest` (the engine's event) cannot edit headers, which is why
seeding lives on its own listener rather than in the engine.

**Why decoupling from the reopen decision is correct — not a shortcut.** When a rule
routes a tab into a different container, the engine *cancels* the original request and
creates a new tab. A canceled request never reaches `onBeforeSendHeaders`, so the
seeder never fires for the pre-reopen tab. The **new** tab re-navigates, and *its*
request fires `onBeforeSendHeaders` in the **final** container. So the seeder always
runs exactly once, against the tab's real destination store, without ever inspecting
the routing `Decision`. The `stay` / auto-name / already-contained cases behave the
same way: the request proceeds (not canceled), `onBeforeSendHeaders` fires, the seeder
seeds into the current store.

```
  webRequest.onBeforeRequest (engine)  ── cancel + reopen ──►  new tab re-navigates
        │ (proceed, or canceled)                                     │
        ▼                                                            ▼
  webRequest.onBeforeSendHeaders (seeder)  ◄──── fires only for non-canceled requests
        │  specs = cookiesFor(d.url, config)          (pure; empty ⇒ early-out)
        │  tab   = getTab(d.tabId)  → store = tab.cookieStoreId
        ▼
  for each spec:  setCookie({...spec, storeId: store})     ← into the tab's OWN store (F11)
                  if not already in the Cookie header:
                      getCookie → splice into header (F12 first-request)
        ▼
  return { requestHeaders } if changed, else undefined
```

## 3. The pure core

Kept out of the engine per the CLAUDE.md layering rule (matching logic lives in the
resolver/matcher, never the engine):

- **`cookiesFor(url, config): CookieSpec[]`** — returns the `cookies` list of the
  **first rule** whose `match` covers `url`, or `[]` when no rule matches or the matched
  rule's action is `ignore`. Uses the injected `matchRule` (first-match precedence), so
  it inherits the exact routing precedence and can't drift from it. This is the whole
  "does the overlay fire, and with what?" decision — pure, no browser.

- **`parseCookieHeader(headers): Record<string,string>`** — splits an existing
  `Cookie:` request header into a `{name: value}` jar (empty when absent).

- **`writeCookieHeader(headers, jar): HttpHeader[]`** — returns a new header array with
  the `Cookie` header rebuilt from the jar (appended if there was none).

Both header helpers are pure and round-trippable, so the fiddly string handling is
proven without a browser.

## 4. Behavior: TC parity (`setCookie` unconditional, header rewrite conditional)

The seeder mirrors TCP's `maybeSetAndAddToHeader`, minus TCP's temp-only restriction —
we seed into **any** container a matching rule targets:

```
onBeforeSendHeaders(async d):
  if d.type != "main_frame": return
  specs = cookiesFor(d.url, config)          # pure early-out
  if specs is empty: return
  tab = await port.getTab(d.tabId); if !tab: return          # tab raced away — fail open
  store = tab.cookieStoreId
  jar = parseCookieHeader(d.requestHeaders)
  changed = false
  for c in specs:
    await port.setCookie({ ...c, storeId: store })           # UNCONDITIONAL (TC parity)
    if jar[c.name] == c.value: continue                      # already on the wire — skip
    got = await port.getCookie({ name: c.name, url: d.url, storeId: store })
    if got: jar[got.name] = got.value; changed = true
  return changed ? { requestHeaders: writeCookieHeader(d.requestHeaders, jar) } : undefined
```

Two-pronged F12 guarantee, matching TC:

1. **`setCookie` into the tab's own store** happens during the *blocking* header phase,
   before the request is released — so the cookie exists before the server responds and
   before any page JavaScript reads `document.cookie`.
2. **The outgoing `Cookie` header is rewritten** so even *this first* main_frame request
   carries the cookie to the server (what makes a server-read consent cookie like `SOCS`
   take effect on first paint; `setCookie` alone would cover only client-side reads and
   subsequent requests).

**F11 (identity boundary):** every `setCookie` passes `storeId: tab.cookieStoreId` — the
cookie is written into the tab's *own* container and nowhere else. The overlay can never
copy a cookie across containers; there is no code path that reads from one store and
writes to another.

**Unconditional `setCookie` (refines CONFIG.md).** TC calls `cookies.set` on every
matching navigation; only the header rewrite is conditional (skipped when the cookie is
already on the wire with the same value). This slice matches that: a value the page later
changed is re-enforced to the configured value on the next top-level navigation — fine,
and usually desirable, for consent/pref cookies. CONFIG.md currently says "seeded … when
the cookie is absent"; **that line is updated** to reflect unconditional TC-parity
seeding as part of this slice.

## 5. Config parser & types

- **`CookieSpec`** (new; the **complete** `browser.cookies.set` detail surface, minus
  `storeId`):
  - `name: string` — **required**
  - `url: string` — **required** (scopes the cookie: domain + path + scheme)
  - `value?: string` — defaults to `""`
  - `domain?: string`, `path?: string`
  - `secure?: boolean`, `httpOnly?: boolean`
  - `sameSite?: "no_restriction" | "lax" | "strict"`
  - `expirationDate?: number` (seconds since epoch; session cookie when omitted)
  - `firstPartyDomain?: string` (first-party isolation)
  - `partitionKey?: { topLevelSite?: string }` (partitioned/CHIPS cookies)
  - **`storeId` is deliberately *not* a field.** The seeder always sets it to the tab's
    own `cookieStoreId`; exposing it would let config write across the container
    boundary, which is exactly the F11 invariant this overlay must preserve.
- **`Rule.cookies?: CookieSpec[]`** — the resolver keeps ignoring it (its type comment
  already notes overlays exist on the real rule but `resolve()` ignores them). A future
  `scripts` slice adds its own `Rule.scripts?` field the same way.
- **`parseRule`** now reads the `cookies` key (today allow-listed but dropped) and
  validates each entry, raising `ConfigError` with a path on:
  - `cookies` not a list, or an entry that isn't a mapping;
  - missing/empty/non-string `name` or `url`;
  - wrong-typed optional fields (`value`/`path`/`domain`/`firstPartyDomain` non-string,
    `secure`/`httpOnly` non-bool, `sameSite` outside the allowed set, `expirationDate`
    non-number, `partitionKey` not an object);
  - unknown keys inside a cookie entry;
  - **`cookies` present on an `ignore` rule** — CONFIG.md forbids overlays on `ignore`.

No manifest change: `cookies` and `webRequestBlocking` are already in
`extensions/cc/manifest.json` (the `cookies` permission was kept for container reopen;
`browser.cookies.set` needs the same permission).

## 6. Port seam

`BrowserPort` gains three methods (real adapter in `browser-port.ts`, mock in the L3
test double):

- **`onBeforeSendHeaders(handler)`** — real port binds
  `webRequest.onBeforeSendHeaders` with `{ types: ['main_frame'] }, ['blocking',
  'requestHeaders']`; the handler receives details including `requestHeaders` and returns
  `{ requestHeaders? } | void`. The mock stores the handler so a test can fire scripted
  details and inspect the returned response — exactly how `onBeforeRequest` is mocked
  today.
- **`setCookie(details)`** — wraps `browser.cookies.set`.
- **`getCookie(details)`** — wraps `browser.cookies.get` (the read-back before header
  injection).

New detail types in `port.ts`: `HttpHeader { name; value? }`,
`HeadersDetails { requestId; tabId; url; type; requestHeaders: HttpHeader[] }`,
`BlockingHeadersResponse { requestHeaders?: HttpHeader[] }`, `SetCookieDetails`,
`GetCookieDetails`, `Cookie` (the get result). The adapter methods are mechanical and
logic-free, like the rest of `browser-port.ts`.

## 7. Wiring

`background.ts` adds one line beside the engine and disposer:

```ts
createCookieSeeder({ port, config, deps: { matchRule } });
```

`config` is the same parsed config the engine uses; `matchRule` is the same injected
matcher. No change to `createEngine` or `createDisposer`.

## 8. Testing (down the pyramid)

- **Pure (no browser):**
  - `cookiesFor` — returns the matched rule's `cookies`; `[]` for no-match and for an
    `ignore` rule; first-match precedence (a broad rule below a specific one doesn't
    win). Property check: for any config, the result equals the `cookies` of whatever
    rule `matchRule` selects (or `[]`).
  - `parseCookieHeader` / `writeCookieHeader` — round-trip; absent header ⇒ empty jar ⇒
    header appended; existing cookies preserved and merged.
- **Config parse:** `cookies` parsed into `Rule.cookies`; each validation error above,
  asserted by message/path; a valid multi-cookie rule; `cookies`-on-`ignore` rejected.
- **L3 (mock port):** the seeder against scripted `onBeforeSendHeaders` details —
  - seeds into the correct `storeId` with the mapped fields;
  - returned `requestHeaders` carry the seeded cookie (merged with any pre-existing
    `Cookie` header);
  - **no-op** (returns `undefined`, no `setCookie`) when no rule matches or the rule is
    `ignore`;
  - header **not** rewritten (but `setCookie` still called) when the cookie is already on
    the wire with the same value — the F12 conditional;
  - tab-gone (`getTab` → null) ⇒ fail open, no throw.
- **L4 real Firefox (F11 + F12):** a bundled rule seeding a cookie into its container →
  load the site; the driver reads `document.cookie` and finds the cookie in that
  container's tab, **and absent** when the same site is opened in a different container
  (the F11 boundary). The harness test server records the incoming `Cookie` header so the
  test also asserts the **first** request already carried the seeded cookie (the F12
  first-request half). One confirmation, tolerant of headless timing per the existing L4
  conventions.

## 9. Risks & mitigations

- **F12 first-paint race** — mitigated by seeding on the *blocking* `onBeforeSendHeaders`
  (`await setCookie` before releasing the request) and rewriting the outgoing header, so
  the cookie is both in the store and on the wire before the server responds. Proven at
  L3 (ordering deterministic) and confirmed at L4 (server records the header).
- **F11 boundary bug** — mitigated structurally: `storeId` is always the tab's own
  `cookieStoreId`; there is no cross-store read/write path. L4 asserts absence in a
  sibling container.
- **Seeder fires for every main_frame request** (all URLs) — cheap: `cookiesFor` is a
  pure early-out returning `[]` for the common no-match case before any `await`.
- **Overlay drift from routing precedence** — avoided by routing `cookiesFor` through the
  same injected `matchRule`, not a parallel matcher.
```
