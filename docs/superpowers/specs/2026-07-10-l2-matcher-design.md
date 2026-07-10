# L2 Matcher (bare-hostname) — Design

**Date:** 2026-07-10
**Status:** Approved, pending implementation plan
**Topic:** The real URL→matcher predicate + first-match `matchRule`/`matchGroup`, bare-hostname grammar only.

## 1. Goal & scope

Build the production **bare-hostname matcher** and the first-match `matchRule` /
`matchGroup` functions that replace the injected test doubles the L1 resolver used.
Pure, no I/O.

### In scope

- Bare-hostname **shorthand** matching (`bandcamp.com` → the `*://*.bandcamp.com/*`
  subtree) with correct dot-boundary / suffix-trap semantics.
- **Any-of lists** (a rule/group matches if *any* of its matchers hits).
- First-match `matchRule(url, rules)` / `matchGroup(url, groups)` that satisfy the
  resolver's `Deps` shape.
- Table + fuzz (fast-check) tests.

### Out of scope (deferred, YAGNI — the real config uses none of these today)

- WebExtension **match patterns** (`https://app.example.com/work/*`) — a later slice.
- The **regex** escape hatch and its catastrophic-backtracking guard — a later slice
  (it pulls in a regex-safety tooling decision: RE2 / linear-time engine).
- The PSL **`sameSite`** check — a separate next slice (the resolver injects it too).
- Config **parsing** (YAML/JSON → `Config`) — deferred; this slice provides matcher
  constructors, not a file parser.

Rationale: every `match:` in `configurable-containers.config.yaml` and the TESTS.md
example config is a bare hostname or a list of bare hostnames. Shorthand covers all
current real usage.

## 2. Shorthand semantics (the suffix-match trap)

`bandcamp.com` matches a URL iff the URL's **canonical host** equals the matcher's
canonical host **or** is a **dot-bounded subdomain** of it:

```
hostMatches(bare, url):  h === b  ||  h.endsWith("." + b)   // on canonical hosts
```

Matches / non-matches:

| URL host | `bandcamp.com` matcher | Why |
|---|---|---|
| `bandcamp.com` | ✅ | equals (the bare host matches its own shorthand) |
| `www.bandcamp.com`, `a.b.bandcamp.com` | ✅ | dot-bounded subdomain |
| `notbandcamp.com` | ❌ | ends with `bandcamp.com` but **not** `.bandcamp.com` (no dot boundary) |
| `bandcamp.com.evil.tld` | ❌ | `bandcamp.com` is a **prefix**, not a suffix |
| `bandcamp.org` | ❌ | different host |

A **specific-subdomain** matcher `mail.google.com` matches `mail.google.com` and its
subdomains, but **not** `google.com` (bare host is more specific).

This resolves TESTING.md's murky wording: the bare host **does** match its own
shorthand; the excluded cases are `notX`, `X.evil.tld`, and non-suffix hosts.

### Canonicalization (fuzz targets)

Both the matcher's host and the URL's host are canonicalized identically so
comparisons are robust:

- **Case-insensitive** — `BANDCAMP.COM` ≡ `bandcamp.com`.
- **Trailing dot stripped** — `bandcamp.com.` ≡ `bandcamp.com`.
- **Port-agnostic** — use `URL.hostname` (no port), not `URL.host`.
- **IDN/punycode normalized** — `münchen.de` ≡ `xn--mnchen-3ya.de`. Achieved by
  running the matcher's host string through the URL parser too:
  `new URL("http://" + host).hostname` yields the lowercased, punycoded, dot-stripped
  form. The matcher stores this canonical form.
- **Scheme** — only `http`/`https` URLs match (mirrors `*://`, excludes
  `file:`/`about:`). A non-http(s) or hostname-less URL never matches.

`matches()` must **never throw** on a malformed URL — it returns `false`. (The engine
only feeds it http/https main_frame URLs, but the predicate is defensively total.)

## 3. Interface & Matcher-type decoupling

The resolver treats `Matcher` as **opaque (`unknown`)** and never inspects it, so
`src/resolver/types.ts` stays unchanged (`Matcher = unknown`; zero L1 churn). The
matcher module owns the concrete type:

```ts
// src/matcher/matcher.ts
import type { Rule, Group } from "../resolver/types";

export type HostMatcher = { kind: "host"; host: string }; // host is the CANONICAL form
export type Matcher = HostMatcher; // extensible later: | PatternMatcher | RegexMatcher

// Construct + validate + canonicalize. Throws on a non-hostname (path/space/empty).
export function hostMatcher(host: string): HostMatcher;

// Does one matcher hit this URL? Dispatches on matcher.kind (only "host" for now).
// Never throws; returns false on a malformed / non-http(s) URL.
export function matches(m: Matcher, url: string): boolean;

// First-match over a rule/group list, treating each Rule/Group `match` entry as a
// Matcher. These satisfy the resolver's Deps shape and drop in where the L1 doubles
// were injected.
export function matchRule(url: string, rules: Rule[]): Rule | null;
export function matchGroup(url: string, groups: Group[]): number | null;
```

`Rule.match` / `Group.match` are `Matcher[]` at the resolver level (typed `unknown[]`
there). `matchRule`/`matchGroup` treat each entry as a concrete `Matcher` (host only
in this slice). A rule/group matches if **any** of its entries matches (any-of lists);
`matchRule` returns the **first** such rule, `matchGroup` the **first** such group's
index — matching the resolver's `Deps` contract exactly.

Note: producing `HostMatcher`s from raw config text is the config parser's job
(deferred). `hostMatcher()` is the constructor that parser will call; L2 tests call it
directly.

## 4. Testing

**Table** (`test/matcher/matcher.test.ts`):
- Every row of the §2 table (bare/subdomain matches; `notbandcamp.com`,
  `bandcamp.com.evil.tld`, `bandcamp.org` non-matches).
- Canonicalization: uppercase host, trailing dot, explicit port, path/query ignored,
  an IDN pair (unicode vs punycode).
- Specific-subdomain matcher (`mail.google.com` matches its subtree, not `google.com`).
- `hostMatcher()` rejects non-hostnames (with a path, with spaces, empty).
- Any-of list via `matchRule` (a rule with `[a.com, b.com]` matches either).
- First-match ordering via `matchRule` (earlier rule wins) and `matchGroup`.
- `matches()` returns `false` (no throw) for `about:blank`, `file:///x`, a garbage
  string.

**Fuzz** (`test/matcher/matcher.props.test.ts`, fast-check):
- *Equivalence to a reference*: random canonical host + random URL, assert
  `matches(hostMatcher(bare), url)` equals an independent reference
  (`h === bare || h.endsWith("." + bare)` on canonicalized hosts).
- *No cross-domain leakage*: for a generated bare host and a URL whose host is **not**
  a dot-bounded suffix of it, `matches` is `false` (the safety invariant — a matcher
  never reaches a different registrable domain).
- *Totality*: `matches(m, anyString)` never throws.

Determinism: seeded fast-check; a failing case prints its seed.

## 5. Files

```
src/matcher/matcher.ts              HostMatcher, hostMatcher(), matches(), matchRule(), matchGroup()
test/matcher/matcher.test.ts        table / traps
test/matcher/matcher.props.test.ts  fuzz
```

Toolchain is the repo's existing TS + Vitest + fast-check (added in L1). `tsconfig`
`include` already covers `src` and `test`.

## 6. What this slice does *not* prove

Only bare-hostname matching. Match patterns, regex (+ backtracking safety), and the
PSL registrable-domain `sameSite` are separate slices. After this slice, `resolve()`
can run its routing decisions on the **real** `matchRule`/`matchGroup` (host grammar)
instead of the injected doubles; the PSL `sameSite` double remains until its slice.
