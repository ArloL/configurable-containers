# PSL `sameSite` — Design

**Date:** 2026-07-10
**Status:** Approved, pending implementation plan
**Topic:** The real registrable-domain (eTLD+1) same-site check that replaces the L1/L3 injected double.

## 1. Goal & scope

Build the production `sameSite(a, b): boolean` (+ a `registrableDomain(url)` helper)
using the Public Suffix List **with the private section honoured**, replacing the
last-two-labels stand-in the resolver injects as `Deps.sameSite`. Pure, no network.

### In scope

- `registrableDomain(url)` — eTLD+1 via **tldts**, private suffixes honoured.
- `sameSite(a, b)` — registrable-domain equality with a defined null-domain fallback.
- Table + light property tests.
- An **integration test** running `resolve()` on the real `matchRule`/`matchGroup`
  (L2) + this real `sameSite` — the first time all pure pieces compose on production
  deps.

### Out of scope

- Match-patterns / regex matcher grammars (separate slices).
- Live config wiring (no config parser / extension entry yet). The resolver still
  receives `sameSite` via `Deps` injection.

### Why the PSL (not naive matching)

"Same site" = **registrable domain (eTLD+1)** from the PSL. Naive last-two-labels
treats every `*.co.uk` (and `com.au`, `co.jp`, …) as one site, so `bbc.co.uk` →
`theguardian.co.uk` would wrongly *keep the same throwaway* and share cookies across
unrelated sites (F11/F3 — a silent identity leak). Only the PSL knows where the
public suffix ends.

**Private section honoured (CONFIG decision).** The PSL private section lists
company-operated suffixes (`github.io`, `vercel.app`, `*.myshopify.com`,
`*.blogspot.com`). Honouring it means `foo.github.io` and `bar.github.io` resolve to
**different** registrable domains → different sites → never share a throwaway. That
is the more correct isolation, and what we want by default.

## 2. Library & dependency

**tldts.** `getDomain(input, { allowPrivateDomains: true })` returns the registrable
domain honouring the private section — the CONFIG requirement in one call. Fast
(trie-based), extension-friendly (pure JS), and it bundles a PSL snapshot.

- tldts is added to **`dependencies`** (runtime code the extension will bundle), the
  project's first runtime dependency — not `devDependencies`.
- The bundled PSL is **refreshed via Renovate** (already active on the repo),
  satisfying CONFIG's "bundled at build time and refreshed on a cadence." No runtime
  fetch.

## 3. Interface

```ts
// src/psl/same-site.ts
import { getDomain, parse } from "tldts";

// The registrable domain (eTLD+1) of a URL or hostname, private suffixes honoured;
// null when there is none (IP, single-label host, a bare public suffix, invalid).
export function registrableDomain(url: string): string | null;

// Same-site check for the resolver's Deps.sameSite. Total (never throws).
export function sameSite(a: string, b: string): boolean;
```

## 4. Semantics

`registrableDomain(url)` = `getDomain(url, { allowPrivateDomains: true })` (returns
`null`, not a throw, for hosts with no registrable domain).

`sameSite(a, b)`:
1. `da = registrableDomain(a)`, `db = registrableDomain(b)`.
2. If **both non-null** → `da === db`. (The definition of same-site.)
3. If **both null** → exact **hostname** equality (lowercased). Keeps continuity when
   navigating around a single IP / `localhost` / single-label host.
4. If **exactly one null** → `false`. A null-domain host is never the same site as a
   real registrable domain.

`sameSite` is **total**: malformed / non-http inputs yield `null` domains and fall
through to step 3/4 (hostname compare or `false`) — never a throw.

Worked cases:

| a | b | result | why |
|---|---|---|---|
| `https://bbc.co.uk/` | `https://theguardian.co.uk/` | **false** | `co.uk` is a public suffix; different registrable domains |
| `https://www.reddit.com/` | `https://old.reddit.com/` | **true** | both `reddit.com` |
| `https://foo.github.io/` | `https://bar.github.io/` | **false** | private suffix `github.io`; different registrable domains |
| `https://a.example.com/` | `https://example.com/` | **true** | both `example.com` |
| `http://127.0.0.1/x` | `http://127.0.0.1/y` | **true** | both null-domain, same host |
| `http://127.0.0.1/` | `http://10.0.0.1/` | **false** | both null-domain, different host |
| `http://localhost/` | `https://example.com/` | **false** | one null-domain, one real |

Scheme is ignored (containers don't split http vs https).

Hostname extraction for the step-3 fallback uses tldts `parse(input).hostname` (or a
URL parse), lowercased; if even that is null for both, `false`.

## 5. Testing

**Table** (`test/psl/same-site.test.ts`):
- Every row of the §4 table.
- An **exception rule**: `city.kawasaki.jp` is a public suffix but `!city.kawasaki.jp`
  is an exception, so `www.city.kawasaki.jp` and `foo.city.kawasaki.jp` share the
  registrable domain `city.kawasaki.jp` → `sameSite` true; while `a.kawasaki.jp` and
  `b.kawasaki.jp` (under the `*.kawasaki.jp` wildcard, no exception) are different. (A
  concrete PSL wildcard+exception check; exact expectations verified against tldts
  during implementation and pinned as the asserted values.)
- `registrableDomain` returns `null` for an IP, `localhost`, and junk.

**Property** (`test/psl/same-site.props.test.ts`, fast-check over a small host pool):
- *Reflexivity*: `sameSite(u, u)` is `true` for any generated real URL.
- *Symmetry*: `sameSite(a, b) === sameSite(b, a)`.
- *Totality*: `sameSite(junk, junk)` never throws.

(We do **not** fuzz PSL correctness itself — tldts is well-tested. Our tests cover
*our wrapper*: the private flag, the null-domain fallback rule, symmetry, totality.)

**Integration** (`test/integration/resolve-real-deps.test.ts`):
Build `Deps` from the real `matchRule`/`matchGroup` (`src/matcher/matcher.ts`) and the
real `sameSite`/… (`src/psl/same-site.ts`), and run `resolve()` end-to-end on
production deps:
- Disposable path, `bbc.co.uk` (temp T) → `theguardian.co.uk` ⇒ **new temporary**
  (the `co.uk` trap now isolates for real — the headline payoff).
- `www.reddit.com` (temp T) → `old.reddit.com` ⇒ **stay** (real registrable-domain
  continuity).
- Group continuity with real host matchers: `google.com` (temp T) → `youtube.com`
  with a `[google.com, youtube.com]` group ⇒ **stay**.
- `foo.github.io` (temp T) → `bar.github.io` ⇒ **new temporary** (private-section
  isolation through the whole engine).

`Deps` is assembled inline: `{ matchRule, matchGroup, sameSite }` from the two real
modules. Rules/groups are built with `hostMatcher(...)`.

## 6. Files

```
src/psl/same-site.ts                        registrableDomain(), sameSite()
test/psl/same-site.test.ts                  table traps + totality
test/psl/same-site.props.test.ts            reflexivity / symmetry / totality
test/integration/resolve-real-deps.test.ts  resolve() on real matcher + real PSL
```

Toolchain: existing TS + Vitest + fast-check, plus `tldts` (new runtime dep).
`tsconfig` `include` already covers `src`/`test`.

## 7. What this slice does *not* prove

Registrable-domain same-site only. Match-patterns/regex grammars and the live config
path (parser + extension wiring) remain out. After this slice, `resolve()`'s
disposable-path continuity runs on a **real** PSL check; the only injected doubles
left are for the matcher grammars not yet built (match-pattern/regex), which the real
config doesn't use.
