// The three match grammars as pure predicates over a URL. No browser, no I/O. See
// docs/superpowers/specs/2026-07-10-l2-matcher-design.md §2–§3 for the shorthand and
// docs/superpowers/specs/2026-08-19-match-patterns-and-regex-design.md §2–§4 for the other
// two, and for why a regex has no pattern form.

import type { Rule, Group } from "../resolver/types";

// The config's shorthand: a host and everything under it (`bandcamp.com` covers
// `www.bandcamp.com`). `host` is the CANONICAL form.
export type HostMatcher = { kind: "host"; host: string };

// A WebExtension match pattern, split at construction into the three parts it matches on.
// `pattern` is the canonical re-serialization, not what the user wrote, because it is also
// what the script-injector hands Firefox (matcherToPatterns): registering
// `*://*.BandCamp.COM/*` while matching `bandcamp.com` here is the drift this prevents.
export type PatternMatcher = {
  kind: "pattern";
  pattern: string;
  scheme: "*" | "http" | "https"; // "*" is http+https; see patternMatcher
  host: string | null; // null = the bare "*" host wildcard (any host)
  subdomains: boolean; // the leading "*." — the host AND everything under it
  path: RegExp; // the path glob, compiled and anchored
};

// The escape hatch, matched against the whole URL. `source` is kept for the config
// round-trip; `re` is compiled once at parse time, so a broken regex is a config error
// rather than a per-navigation throw.
export type RegexMatcher = { kind: "regex"; source: string; re: RegExp };

export type Matcher = HostMatcher | PatternMatcher | RegexMatcher;

// Canonicalize a hostname: lowercase + punycode + no trailing dot, via the URL parser.
// Throws if the input is not a bare hostname (scheme, path, port, whitespace, or empty).
function canonicalHost(hostish: string): string {
  // Reject the characters that would let the parser read this as something other than a
  // bare hostname before it gets the chance. The empty string is left to the parser:
  // "http:///" does not parse, so it throws one line later anyway, and a check that only
  // repeats the next line's answer is one no test can tell from its absence.
  if (/[\s/\\?#@:]/.test(hostish)) {
    throw new Error(`not a bare hostname: ${JSON.stringify(hostish)}`);
  }
  let u: URL;
  try {
    // Stryker disable next-line StringLiteral: the trailing "/" spells out the empty path
    // being asked about; without it the input is a bare authority and every hostname parses
    // the same, since the class above rejected anything that could start a path.
    u = new URL("http://" + hostish + "/");
  } catch {
    throw new Error(`not a bare hostname: ${JSON.stringify(hostish)}`);
  }
  // Reject anything the parser reinterpreted.
  // Stryker disable all: unreachable from any input that gets this far — a port needs ":"
  // and userinfo "@", both rejected above, and an http url with no host does not parse. It
  // is the second line of defence: drop ":" from that class and this is what still throws.
  /* v8 ignore next 3 -- unreachable, as above; named for the coverage gate the way the
     Stryker note names it for the mutation one. */
  if (u.hostname === "" || u.port !== "") {
    throw new Error(`not a bare hostname: ${JSON.stringify(hostish)}`);
  }
  // Stryker restore all
  return stripTrailingDot(u.hostname);
}

function stripTrailingDot(h: string): string {
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

// The parsed form of an http(s) URL, or null if it is not one (never throws). Every grammar
// below answers `false` for what this rejects: a matcher routes top-level http(s)
// navigations, and `about:`/`file:`/`moz-extension:` are the engine's business.
function httpUrl(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // Stryker disable next-line all: unreachable — an http(s) url with no host does not parse
  // ("http:///" throws). Kept because the null-return contract is this function's, not the
  // URL parser's.
  /* v8 ignore next -- unreachable, as the note above says. */
  if (u.hostname === "") return null;
  return u;
}

export function hostMatcher(host: string): HostMatcher {
  return { kind: "host", host: canonicalHost(host) };
}

function badPattern(pattern: string, why: string): Error {
  return new Error(`not a valid match pattern (${why}): ${JSON.stringify(pattern)}`);
}

// Parse `<scheme>://<host><path>`, the WebExtension match-pattern grammar, keeping only the
// parts this extension can act on. Two narrowings, both loud rather than silently inert:
//
//   - Schemes are http, https or `*`. Firefox also has `ws`, `wss`, `file`, `ftp`, `data`,
//     but a rule naming one could never fire — routing only sees http(s) navigations. So
//     `*` means http+https, as it does for a Firefox content script.
//   - The host wildcard is a leading `*.` or a bare `*`, nothing else. Firefox rejects
//     `*.foo.*` and `*foo.com` too, and reading them leniently is how `*.google.*` would
//     look like it covers every Google ccTLD while matching nothing. Use a regex for that.
export function patternMatcher(pattern: string): PatternMatcher {
  const sep = pattern.indexOf("://");
  if (sep === -1) {
    throw badPattern(pattern, 'a pattern needs a scheme, as in "*://*.example.com/*"');
  }
  const scheme = pattern.slice(0, sep);
  if (scheme !== "*" && scheme !== "http" && scheme !== "https") {
    throw badPattern(pattern, `unsupported scheme "${scheme}" — use http, https or *`);
  }
  const rest = pattern.slice(sep + 3);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    throw badPattern(pattern, 'a pattern needs a path, as in "*://example.com/*"');
  }
  const hostish = rest.slice(0, slash);
  const glob = rest.slice(slash);

  const subdomains = hostish.startsWith("*.");
  let host: string | null;
  if (hostish === "*") {
    host = null;
  } else {
    const bare = subdomains ? hostish.slice(2) : hostish;
    if (bare.includes("*")) {
      throw badPattern(pattern, 'a host wildcard is only "*" or a leading "*."');
    }
    try {
      host = canonicalHost(bare);
    } catch {
      throw badPattern(pattern, `"${bare}" is not a hostname`);
    }
  }

  const shown = host === null ? "*" : (subdomains ? "*." : "") + host;
  return {
    kind: "pattern",
    pattern: `${scheme}://${shown}${glob}`,
    scheme,
    host,
    subdomains,
    path: globToRegExp(glob),
  };
}

// A match pattern's path is a glob whose only metacharacter is `*` (any run of any
// characters, `/` included). Everything else is literal, hence the escape before the
// wildcards go back in: without it `/a.b` would match `/axb` too.
function globToRegExp(glob: string): RegExp {
  const body = glob.split("*").map(escapeRegExp).join("[\\s\\S]*");
  return new RegExp(`^${body}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The regex escape hatch. Compiled here so a broken regex is rejected while the config is
// read — inside the blocking handler there is nobody left to tell. No flags: the URL is
// already canonical (lowercase scheme and host), and a case-insensitive PATH is a different
// question, which the user can ask for with `[Aa]`.
export function regexMatcher(source: string): RegexMatcher {
  if (source === "") throw new Error("not a valid regular expression: empty");
  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch {
    throw new Error(`not a valid regular expression: ${JSON.stringify(source)}`);
  }
  return { kind: "regex", source, re };
}

export function matches(m: Matcher, url: string): boolean {
  const u = httpUrl(url);
  if (u === null) return false;
  const h = stripTrailingDot(u.hostname);
  switch (m.kind) {
    case "host":
      return h === m.host || h.endsWith("." + m.host);
    case "pattern":
      return (
        (m.scheme === "*" || u.protocol === m.scheme + ":") &&
        (m.host === null || h === m.host || (m.subdomains && h.endsWith("." + m.host))) &&
        // Path and query, never the fragment: a fragment never reaches the server. Query
        // is included because the config promises query matching, and it costs nothing for
        // the ordinary trailing-`*` pattern, which covers one either way.
        m.path.test(u.pathname + u.search)
      );
    case "regex":
      // The canonical href, not the string handed in: `https://x.com` and `https://X.com/`
      // are one URL, and an anchored `^https://x\.com/` must hold for both. Firefox
      // normalizes before webRequest sees it; a hand-built L1 config does not.
      return m.re.test(u.href);
  }
}

// The resolver stores matchers as an opaque `unknown[]`; here they are concrete `Matcher`s.
function anyMatch(entries: unknown[], url: string): boolean {
  return entries.some((e) => matches(e as Matcher, url));
}

export function matchRule(url: string, rules: Rule[]): Rule | null {
  return rules.find((r) => anyMatch(r.match, url)) ?? null;
}

export function matchGroup(url: string, groups: Group[]): number | null {
  const i = groups.findIndex((g) => anyMatch(g.match, url));
  return i === -1 ? null : i;
}

// The match patterns covering a matcher's matches() semantics for http(s), for the
// script-injector, which registers against patterns rather than urls. A HostMatcher covers
// the bare host OR any subdomain, so it expands to two; a PatternMatcher is already one.
//
// A RegexMatcher has no pattern form — no finite set of patterns describes an arbitrary
// regex — so this throws rather than inventing a wider one: `*://*/*` would inject the
// user's snippet into every page they open. `config/parse` keeps it unreachable by refusing
// `scripts` on a rule whose match list contains a regex.
export function matcherToPatterns(m: Matcher): string[] {
  switch (m.kind) {
    case "host":
      return [`*://${m.host}/*`, `*://*.${m.host}/*`];
    case "pattern":
      return [m.pattern];
    case "regex":
      throw new Error(`a regex match has no URL-pattern form: ${JSON.stringify(m.source)}`);
  }
}

// The longest path a generated pattern carries. The result stays a pattern that MATCHES the
// URL it came from — a prefix plus the trailing `*` — so truncation only widens it, and a
// path longer than this is not one a rule is written at character by character. The cap is
// here rather than at the caller because the record it feeds is written to disk on every
// navigation of an armed container, and an unbounded path is an unbounded row.
export const MAX_PATTERN_PATH = 200;

// The match pattern for ONE observed URL: its host and path, and nothing else. `null` for
// anything `matches()` would answer false for anyway (a non-http(s) url) and for a host no
// pattern can carry (an IPv6 literal — `canonicalHost` refuses the colons), so what this
// returns always parses back through `patternMatcher`.
//
// Four narrowings, each of which the obvious version gets wrong:
//
//   - **`*://`, not the scheme seen.** HSTS rewrites the scheme before webRequest is told
//     about the navigation, so which one was observed is an accident of when the upgrade
//     landed. `*` is http+https, which is what the shorthand means too.
//   - **The host loses its port.** A match pattern's host cannot carry one, and CC does not
//     match on it either: `https://company.com:8443/` matches `company.com`.
//   - **A trailing `*`, which is the QUERY.** A pattern's path is anchored at both ends, so
//     `/login/oauth/authorize` alone does not answer `/login/oauth/authorize?client_id=…`,
//     and that is every OAuth entry point there is.
//   - **The query itself is dropped**, never pasted into the pattern: it is where session
//     tokens and authorization codes live, and this text is offered for copying out of a
//     record written during a checkout.
//
// A literal `*` in the path becomes a wildcard, since a match pattern has no escape for one.
// That widens the result at that host and cannot be prevented — which is why the record
// shows the pattern it copies rather than deriving it out of sight.
export function patternForUrl(url: string): string | null {
  const u = httpUrl(url);
  if (u === null) return null;
  // Read outside the try, which is what keeps the guard above load-bearing: fold this into
  // it and a null `u` throws INSIDE the catch's reach, so the two failures — "not an http
  // url" and "not a hostname a pattern can carry" — become indistinguishable and the guard
  // can be deleted without a test noticing.
  const path = u.pathname.slice(0, MAX_PATTERN_PATH);
  let host: string;
  try {
    // `canonicalHost` strips the trailing dot itself — the URL parser keeps it in
    // `hostname`, and `https://x.com./` and `https://x.com/` are the same site.
    host = canonicalHost(u.hostname);
  } catch {
    return null;
  }
  return `*://${host}${path}*`;
}
