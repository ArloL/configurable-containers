# Match patterns and the regex escape hatch — Design

**Date:** 2026-08-19
**Status:** Implemented
**Topic:** The two `match` grammars deferred by the L2 matcher slice — WebExtension match
patterns and the `{ regex: … }` escape hatch — as concrete arms of one `Matcher` union,
and what the parser, the auto-naming rule and the script overlay each have to do about
them.

## 1. Goal & scope

`CONFIG.md` has documented three match forms since the first release; only the first was
implemented. `src/config/parse.ts` refused the other two by name — *"regex matches are not
supported yet (bare hostnames only for now)"* — and
`docs/superpowers/specs/2026-07-10-l2-matcher-design.md` §1 deferred them as YAGNI, on the
evidence that every `match:` in the real config was a bare hostname.

The case that retires that rationale is a **group of every Google ccTLD**. Google is
roughly 190 registrable domains, one per country, and the PSL makes each of them a
different site — so `google.com` → `google.de` is a cross-site navigation that spawns a
fresh throwaway and drops whatever session the first one held. The shorthand cannot say
it (a hostname is one subtree), and neither can a match pattern (`*://*.google.*/*` is not
a pattern in Firefox either — a host wildcard is only a leading `*.`). The alternatives
were 190 lines of enumeration, re-checked forever against a list Google publishes and
changes, or the escape hatch the config already promised.

### In scope

- `PatternMatcher` and `RegexMatcher` as arms of `Matcher` in `src/matcher/matcher.ts`,
  with `matches()` dispatching on `kind` as it already did.
- The parser building them, telling the three forms apart by shape, and reporting a
  malformed one as a `ConfigError` naming the entry.
- The two knock-on decisions: **auto-naming** (a rule with no action) and **`scripts`**
  (registered by URL pattern, which a regex has none of).

### Out of scope

- A **catastrophic-backtracking guard**. §5 says why it is not deferred but declined.
- Regex **flags**, `<all_urls>`, and the non-http(s) schemes of Firefox's grammar
  (`ws`, `file`, `ftp`, `data`) — a rule naming one could never fire, since routing only
  ever sees a top-level http(s) navigation, so they are rejected rather than accepted and
  left inert.

## 2. Grammar and semantics

One `Matcher` union, three arms, one predicate. Every arm answers `false` for a URL that
is not http(s), which is what keeps `about:`, `moz-extension:` and `view-source:` the
engine's business rather than a rule's.

```ts
export type HostMatcher = { kind: "host"; host: string };
export type PatternMatcher = {
  kind: "pattern";
  pattern: string;      // canonical re-serialization — what matcherToPatterns hands Firefox
  scheme: "*" | "http" | "https";
  host: string | null;  // null = the bare "*" wildcard
  subdomains: boolean;  // the leading "*."
  path: RegExp;         // the path glob, compiled and anchored
};
export type RegexMatcher = { kind: "regex"; source: string; re: RegExp };
```

**Pattern.** `<scheme>://<host><path>`, validated at construction and stored pre-split so
no parsing happens per navigation. Two places it differs from the shorthand, and both are
places a "helpful" reading would silently widen a rule:

- a bare host in a pattern is **only** that host (`https://example.com/*` is not
  `www.example.com`); `*.` is what asks for the subtree;
- the path glob is **escaped and anchored at both ends** — `*` is its only
  metacharacter — so `/work` is not answered by `/workshop` and `/a.b` is not answered by
  `/axb`.

The path is matched against **pathname + search**, never the fragment: `CONFIG.md`
promises query matching, and a fragment is neither sent to the server nor visible to
webRequest. For the ordinary trailing-`*` pattern the two readings coincide.

**Regex.** Tested against the **canonical href** (`new URL(url).href`), so an anchored
`^https://x\.com/$` holds for the `https://X.COM` a hand-built config or a test hands
over, exactly as it does for the normalized URL Firefox delivers. Compiled at parse time:
inside the blocking `onBeforeRequest` a throw is not a wrong answer, it is a navigation
that never completes.

## 3. Parsing: three forms, told apart by shape

`toMatcher` dispatches before it validates, so each form's own error message survives:

| Raw entry | Read as | On failure |
|---|---|---|
| a mapping | `{ regex: … }` | unknown key / not a string / uncompilable |
| a string containing `://` | match pattern | scheme, host-wildcard, path, hostname |
| any other string | bare hostname | `not a bare hostname`, pointing at the pattern form |

The last row carries the near-miss worth naming: `*.example.com` is what somebody writes
who means the pattern, and the message says so rather than blaming the wildcard.

**Auto-naming needs a bare hostname.** A rule with no action opens in a container named
after its first match entry; a pattern has no single defensible name (`*://*.x.com/a`
could be three) and a regex has none at all, so `parseMatch` reports `firstHost: null` and
`parseRule` refuses the rule, telling the user to add `open:`. Refused rather than
guessed — a wrong container name is a wrong cookie jar, and it is silent.

## 4. `scripts` is refused on a regex rule

`matcherToPatterns` exists because the script-injector registers content scripts against
**URL patterns**, before any navigation, while routing asks `matches()`. The two have to
describe the same set of pages or an overlay fires where its rule does not. A host expands
to its two covering patterns and a pattern is already one — but no finite set of match
patterns describes an arbitrary regex.

The two ways to accept one anyway are both worse than refusing: register `*://*/*` and the
user's snippet runs on every page they open (arbitrary code execution, on a config line
that says nothing of the sort), or register only the rule's non-regex entries and inject
on a subset of what the rule routes, which is a silent wrong answer. So `matcherToPatterns`
**throws** for a regex, and `config/parse` keeps that unreachable by rejecting `scripts` on
a rule whose match list holds one. `cookies` are seeded per navigation through `matchRule`
and need no pattern, so they are unaffected — the asymmetry is real, not an oversight.

## 5. The backtracking guard, declined

`docs/superpowers/specs/2026-07-10-l2-matcher-design.md` §1 deferred the regex form partly
on "it pulls in a regex-safety tooling decision: RE2 / linear-time engine", and
`TESTING.md` L2 claimed a per-match timeout would be asserted. Neither is achievable as
stated: a JavaScript regex is **synchronous and uninterruptible**, so there is no timeout
to implement — only a different engine to depend on. Shipping RE2 (a wasm build, or a
native module a WebExtension cannot load) to bound a hazard the single author writes into
their own config, in an expression they can also just not write, is the wrong trade.

What is done instead: the expression is compiled once at parse time, it is tested against
one URL at a time, and `CONFIG.md` states plainly that a catastrophically backtracking
expression hangs the tab and that nothing will stop it. `TESTING.md` L2 was corrected to
say the guard does not exist rather than to keep describing one.

## 6. Testing

L2 owns all of it; the mutation gate covers `src/matcher/**` at 100%, so every branch
below is killed by a matcher or resolver case rather than by an engine one.

- `test/matcher/matcher.test.ts` — the pattern table (scheme pinning, the three host
  shapes, path anchoring, metacharacter escaping, query vs fragment, canonicalization) and
  every rejection, each asserted on the message a person reads; the regex table (the
  Google-ccTLD expression, canonical-href anchoring, non-http(s), uncompilable/empty);
  `matcherToPatterns` for a pattern and its throw for a regex.
- `test/matcher/matcher.rules.test.ts` — the three grammars in one rule list, pinning that
  first-match is decided by **position and not grammar**: a path-scoped pattern that misses
  falls through to the host rule under it.
- `test/matcher/matcher.props.test.ts` — a host matcher's `matcherToPatterns` expansion
  matches exactly what the matcher itself does, cross-checking the suffix test against the
  pattern machinery; plus totality over arbitrary strings for all three arms.
- `test/config/parse*.test.ts` — acceptance and every new rejection with its yaml path,
  the auto-naming refusal, and `scripts`-on-regex refused while `cookies` on the same rule
  is allowed.
- `test/config/parse.real.test.ts` — the shipped config's google group asserted through
  `matchGroup`: the ccTLDs, YouTube and `accounts.google.com` (F4's chain) resolve to one
  group, and a lookalike to none.

## 7. Decisions taken, with the alternatives rejected

- **Narrow the scheme set to http/https/`*`** rather than accept Firefox's full list. A
  `ws://` rule can never fire; accepting it means a config line that looks like routing and
  is not. Rejected: silent acceptance.
- **Reject a wildcard outside a leading `*.`** rather than read it leniently. `*.google.*`
  is the exact expression a user reaches for here, and a lenient reading would look like it
  covered `google.de` while matching nothing.
- **Regex against the canonical href**, not the raw string. The alternative makes a rule's
  answer depend on who called it.
- **No flags.** The scheme and host are already lowercase; a case-insensitive path is
  expressible as `[Aa]`, and a `flags` key is surface to document, validate and test for a
  case that has not come up.
- **The shipped google group is deliberately loose** (`google.[a-z]{2,3}(\.[a-z]{2})?`): it
  admits a `google.zz` Google does not own. For a continuity group the cost is a stranger
  sharing a *throwaway* with a session that is itself disposable; the cost of being strict
  is the 190-line enumeration this slice exists to avoid. An `open:` rule on the same
  expression would be worth tightening, and the config says so.

## 8. Open questions

- **`<all_urls>`** is not accepted. It is a legal WebExtension token and a plausible thing
  to write, but a rule matching everything defeats auto-naming and is a footgun with no
  demonstrated use here. `*://*/*` says the same thing when it is really wanted.
- **Path matching vs SPA path mutation** stays where `CONFIG.md`'s open questions left it:
  routing is decided per top-level navigation, so a client-side route change never
  re-decides. Path-scoped rules make that visible for the first time.
