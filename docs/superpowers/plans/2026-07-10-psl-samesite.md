# PSL `sameSite` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real `sameSite(a, b)` (+ `registrableDomain(url)`) via tldts (private section honoured), and prove the whole pure engine composes on real deps.

**Architecture:** `registrableDomain` = `tldts.getDomain(url, { allowPrivateDomains: true })`. `sameSite` compares registrable domains, with a defined null-domain fallback (both-null → exact host equality; one-null → false). Total (never throws). An integration test wires the real matcher + real sameSite into `resolve()`.

**Tech Stack:** TypeScript, Vitest, fast-check (in repo); **tldts** (new runtime dependency).

**Spec:** `docs/superpowers/specs/2026-07-10-psl-samesite-design.md` — read §3–§5.

---

## File structure

| File | Responsibility |
|---|---|
| `src/psl/same-site.ts` | `registrableDomain()`, `sameSite()` over tldts. |
| `test/psl/same-site.test.ts` | Table traps (co.uk, github.io, exception, IP/localhost) + totality. |
| `test/psl/same-site.props.test.ts` | fast-check: reflexivity, symmetry, totality. |
| `test/integration/resolve-real-deps.test.ts` | `resolve()` on real `matchRule`/`matchGroup` + real `sameSite`. |

No existing file changes except `package.json` (add tldts). `src/resolver/types.ts` unchanged.

---

## Task 1: tldts dependency + `registrableDomain` + `sameSite`

**Files:**
- Modify: `package.json` (add tldts to `dependencies`)
- Create: `src/psl/same-site.ts`
- Test: `test/psl/same-site.test.ts`

- [ ] **Step 1: Add tldts as a runtime dependency**

Add a top-level `"dependencies"` object to `package.json` (it currently has only
`devDependencies`) with tldts:
```json
  "dependencies": {
    "tldts": "^6.1.0"
  },
```
Place it before `"devDependencies"`. Then run:
```bash
npm install
```
Expected: install succeeds; `tldts` present in `node_modules` and `package-lock.json`.

- [ ] **Step 2: Write the failing tests**

`test/psl/same-site.test.ts`:
```ts
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
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/psl/same-site.test.ts`
Expected: FAIL — cannot resolve `../../src/psl/same-site`.

- [ ] **Step 4: Implement `src/psl/same-site.ts`**

```ts
// Registrable-domain (eTLD+1) same-site check via the Public Suffix List, private
// section honoured. Pure, no network. See
// docs/superpowers/specs/2026-07-10-psl-samesite-design.md §3–§4.
import { getDomain, getHostname } from "tldts";

const OPTS = { allowPrivateDomains: true } as const;

// The registrable domain of a URL/hostname (private suffixes honoured), or null when
// there is none (IP, single-label host, bare public suffix, invalid).
export function registrableDomain(url: string): string | null {
  return getDomain(url, OPTS);
}

// Lowercased hostname, or null. Never throws.
function hostname(url: string): string | null {
  const h = getHostname(url, OPTS);
  return h === null ? null : h.toLowerCase();
}

// Same-site iff same registrable domain; for null-domain hosts (IP/localhost/etc.)
// fall back to exact hostname equality. Total (never throws).
export function sameSite(a: string, b: string): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  if (da !== null && db !== null) return da === db;
  if (da === null && db === null) {
    const ha = hostname(a);
    const hb = hostname(b);
    return ha !== null && ha === hb;
  }
  return false; // exactly one has a registrable domain
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/psl/same-site.test.ts`
Expected: PASS. If the private-section rows fail, confirm tldts is passing
`{ allowPrivateDomains: true }` (without it, `github.io` collapses to one domain).
Report any tldts API surprise (e.g. `getHostname` signature) rather than guessing.

- [ ] **Step 6: Verify types**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/psl/same-site.ts test/psl/same-site.test.ts
git commit -m "feat: PSL sameSite via tldts (registrable domain, private section)"
```

---

## Task 2: PSL wildcard/exception case + properties

Add a concrete PSL wildcard+exception assertion (verified against tldts, not
guessed) and the wrapper properties.

**Files:**
- Modify: `test/psl/same-site.test.ts` (add the exception case)
- Create: `test/psl/same-site.props.test.ts`

- [ ] **Step 1: Determine the real tldts values for the exception domain**

Run this one-off to see what tldts actually returns (do NOT commit this; it just
pins the assertions):
```bash
node --input-type=module -e "import { getDomain } from 'tldts'; const o={allowPrivateDomains:true}; for (const h of ['www.city.kawasaki.jp','foo.city.kawasaki.jp','a.kawasaki.jp','x.a.kawasaki.jp']) console.log(h, '=>', getDomain('https://'+h+'/', o));"
```
Note the printed registrable domains. The PSL has `*.kawasaki.jp` (wildcard) and
`!city.kawasaki.jp` (exception), so `*.city.kawasaki.jp` hosts share registrable
domain `city.kawasaki.jp`, while `*.kawasaki.jp` hosts do not collapse together. Use
the **actual** printed values to write the expectations in Step 2 (adjust the
expected strings to match tldts exactly).

- [ ] **Step 2: Add the exception case to `test/psl/same-site.test.ts`**

Append inside the `describe("sameSite", ...)` block (fill the expected booleans from
Step 1 — the exception makes `city.kawasaki.jp` a registrable domain, so the first
should be `true`; the wildcard hosts differ, so the second should be `false`):
```ts
  it("handles a PSL wildcard + exception (kawasaki.jp)", () => {
    // !city.kawasaki.jp exception -> both share registrable domain city.kawasaki.jp
    expect(sameSite("https://www.city.kawasaki.jp/", "https://foo.city.kawasaki.jp/")).toBe(true);
    // *.kawasaki.jp wildcard, no exception -> different sites
    expect(sameSite("https://a.kawasaki.jp/", "https://b.kawasaki.jp/")).toBe(false);
  });
```
If the Step-1 output contradicts these expectations, trust tldts's actual output and
set the booleans accordingly, adding a one-line comment noting what tldts returned.

- [ ] **Step 3: Write the property tests — create `test/psl/same-site.props.test.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/psl/`
Expected: PASS (the table file incl. the new exception case + the 3 properties).

- [ ] **Step 5: Verify types**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add test/psl/same-site.test.ts test/psl/same-site.props.test.ts
git commit -m "test: PSL wildcard/exception case + sameSite properties"
```

---

## Task 3: Integration — `resolve()` on real matcher + real PSL

Prove the pure engine composes: build `Deps` from the real `matchRule`/`matchGroup`
(L2) and the real `sameSite` (this slice), and run `resolve()` end-to-end.

**Files:**
- Create: `test/integration/resolve-real-deps.test.ts`

- [ ] **Step 1: Write the integration test**

`test/integration/resolve-real-deps.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolve } from "../../src/resolver/resolve";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Deps, NavContext, Config, ContainerRef } from "../../src/resolver/types";

// The REAL production dependencies (host-grammar matcher + PSL same-site).
const deps: Deps = { matchRule, matchGroup, sameSite };

const temp: ContainerRef = { kind: "temporary" };
function nav(targetUrl: string, currentUrl: string): NavContext {
  return { targetUrl, current: { url: currentUrl, container: temp }, initiator: null };
}

describe("resolve() on real matcher + real PSL", () => {
  const noRules: Config = { rules: [], groups: [] };

  it("isolates across the co.uk public suffix (the real trap)", () => {
    const d = resolve(nav("https://theguardian.co.uk/", "https://bbc.co.uk/"), noRules, deps);
    expect(d).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("keeps continuity within a registrable domain", () => {
    const d = resolve(nav("https://old.reddit.com/", "https://www.reddit.com/"), noRules, deps);
    expect(d).toEqual({ kind: "stay" });
  });

  it("isolates across private-suffix domains (github.io)", () => {
    const d = resolve(nav("https://bar.github.io/", "https://foo.github.io/"), noRules, deps);
    expect(d).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("keeps continuity across a real group with real host matchers", () => {
    const cfg: Config = {
      rules: [],
      groups: [{ match: [hostMatcher("google.com"), hostMatcher("youtube.com")] }],
    };
    const d = resolve(nav("https://youtube.com/", "https://google.com/"), cfg, deps);
    expect(d).toEqual({ kind: "stay" });
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run test/integration/resolve-real-deps.test.ts`
Expected: PASS (4 tests). This is the first time `resolve()` runs on production deps;
the `co.uk` and `github.io` isolations now happen for real through the whole engine.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm test`
Expected: all green — harness, resolver, matcher, PSL, and integration tests.
Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add test/integration/resolve-real-deps.test.ts
git commit -m "test: integration — resolve() on real matcher + real PSL sameSite"
```

---

## Out of scope for this plan (deferred)

- Match-patterns / regex matcher grammars (+ regex backtracking guard) — separate slices.
- The config parser (YAML/JSON → `Config`, auto-naming normalization) and the extension entry that assembles live `Deps` — later.
- Overlays and redirector auto-close timing — adapter/effect concerns (L3/L4).
