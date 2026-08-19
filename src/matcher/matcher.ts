// The three match grammars — bare hostname, WebExtension match pattern, regex — as
// pure predicates over a URL. No browser, no I/O. See
// docs/superpowers/specs/2026-07-10-l2-matcher-design.md §2–§3 (the shorthand) and
// docs/superpowers/specs/2026-08-19-match-patterns-and-regex-design.md §2–§4 (the
// other two, and why a regex has no pattern form).

import type { Rule, Group } from "../resolver/types";

// The config's shorthand: a host and everything under it (`bandcamp.com` covers
// `www.bandcamp.com`). `host` is the CANONICAL form.
export type HostMatcher = { kind: "host"; host: string };

// A WebExtension match pattern, split at construction into the three parts it matches
// on. `pattern` is the canonical re-serialization rather than the string the user
// wrote, because it is also what the script-injector hands Firefox (matcherToPatterns)
// — registering `*://*.BandCamp.COM/*` while matching `bandcamp.com` here is exactly the
// drift this type exists to prevent.
export type PatternMatcher = {
  kind: "pattern";
  pattern: string;
  scheme: "*" | "http" | "https"; // "*" is http+https; see patternMatcher
  host: string | null; // null = the bare "*" host wildcard (any host)
  subdomains: boolean; // the leading "*." — the host AND everything under it
  path: RegExp; // the path glob, compiled and anchored
};

// The escape hatch, matched against the whole URL. `source` is kept for the config
// round-trip; `re` is compiled once, at parse time, so a broken regex is a config error
// and not a per-navigation throw.
export type RegexMatcher = { kind: "regex"; source: string; re: RegExp };

export type Matcher = HostMatcher | PatternMatcher | RegexMatcher;

// Canonicalize a hostname string: lowercase + punycode + drop a trailing dot, via
// the URL parser. Throws if the input is not a bare hostname (has a scheme, path,
// port, whitespace, or is empty).
function canonicalHost(hostish: string): string {
  // Reject the characters that would let the parser read the input as something other
  // than a bare hostname (scheme, path, port, userinfo, whitespace) before it gets the
  // chance. The empty string is left to the parser rather than checked here: "http:///"
  // does not parse, so it lands on the same throw one line later, and a check that only
  // ever repeats an answer the next line gives is one no test can tell from its absence.
  if (/[\s/\\?#@:]/.test(hostish)) {
    throw new Error(`not a bare hostname: ${JSON.stringify(hostish)}`);
  }
  let u: URL;
  try {
    // Stryker disable next-line StringLiteral: the trailing "/" spells out the empty path
    // this is asking the parser about; with no "/" the input is a bare authority and every
    // hostname parses to the same thing, because the class above rejected every character
    // that could have started a path.
    u = new URL("http://" + hostish + "/");
  } catch {
    throw new Error(`not a bare hostname: ${JSON.stringify(hostish)}`);
  }
  // Reject anything the parser reinterpreted (userinfo, port, non-empty path is
  // impossible here since we appended "/"; hostname must equal the whole input).
  // Stryker disable all: unreachable from any input that gets this far — a port needs ":"
  // and userinfo needs "@", both rejected above, and an http url with no host does not
  // parse at all. It is the second line of defence for the character class above, and it
  // earns its place there: drop ":" from that class and this is what still throws.
  if (u.hostname === "" || u.port !== "") {
    throw new Error(`not a bare hostname: ${JSON.stringify(hostish)}`);
  }
  // Stryker restore all
  return stripTrailingDot(u.hostname);
}

function stripTrailingDot(h: string): string {
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

// The parsed form of an http(s) URL, or null if it is not one (never throws). Every
// grammar below answers `false` for anything this rejects: a matcher's whole job is to
// route a top-level http(s) navigation, and `about:`/`file:`/`moz-extension:` are the
// engine's business, not a rule's.
function httpUrl(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // Stryker disable next-line all: unreachable — an http(s) url with no host does not
  // parse ("http:///" throws), so this cannot fire for anything the line above let past.
  // Kept because the null-return contract is this function's, not the URL parser's.
  if (u.hostname === "") return null;
  return u;
}

export function hostMatcher(host: string): HostMatcher {
  return { kind: "host", host: canonicalHost(host) };
}

function badPattern(pattern: string, why: string): Error {
  return new Error(`not a valid match pattern (${why}): ${JSON.stringify(pattern)}`);
}

// Parse `<scheme>://<host><path>`, the WebExtension match-pattern grammar, keeping only
// the parts of it this extension can act on. Two deliberate narrowings, both loud rather
// than silently inert:
//
//   - **Schemes are http, https or `*`.** Firefox's grammar also has `ws`, `wss`,
//     `file`, `ftp` and `data`; a rule naming one could never fire, because routing only
//     ever sees a top-level http(s) navigation. `*` therefore means http+https here,
//     which is what it means in Firefox for a content script too.
//   - **The host wildcard is a leading `*.` or a bare `*`, nothing else.** `*.foo.*` and
//     `*foo.com` are not patterns Firefox accepts either, and reading them leniently is
//     how `*.google.*` would look like it covers every Google ccTLD while quietly
//     matching nothing. That case is what the regex form is for.
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

  // The bare "*" is the any-host wildcard; "*.foo.com" is foo.com and everything under
  // it. Both are computed for either shape, so neither carries a value that is only
  // meaningful in the other's branch.
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

// A match pattern's path is a glob whose only metacharacter is `*` — any run of any
// characters, `/` included. Everything else is literal, hence the escape before the
// wildcards go back in: without it `/a.b` would also match `/axb`, and a rule meant for
// one path would route a whole family of them.
function globToRegExp(glob: string): RegExp {
  const body = glob.split("*").map(escapeRegExp).join("[\\s\\S]*");
  return new RegExp(`^${body}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The regex escape hatch. Compiled here so an unparseable regex is rejected while the
// config is being read — inside the blocking request handler there is nobody left to
// tell. No flags: the URL it is tested against is already canonical (lowercase scheme
// and host), and a case-insensitive PATH is a different question the user can ask for
// themselves with `[Aa]`.
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
        // Path and query, never the fragment: a fragment is not sent to the server and
        // is not what a navigation is routed on. `search` is included because the config
        // promises query matching, and it costs nothing for the ordinary trailing-`*`
        // pattern, which covers a query either way.
        m.path.test(u.pathname + u.search)
      );
    case "regex":
      // The canonical href, not the string handed in: `https://x.com` and
      // `https://X.com/` are one URL, and an anchored `^https://x\.com/` has to hold for
      // both. Firefox normalizes before webRequest sees it; a hand-built L1 config or a
      // test does not.
      return m.re.test(u.href);
  }
}

// A rule/group matches if ANY of its matcher entries hits. The resolver stores
// matchers as an opaque `unknown[]`; here they are concrete `Matcher`s.
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

// The WebExtension match patterns that cover a matcher's matches() semantics for
// http(s). A HostMatcher { host } matches the bare host OR any subdomain, so it expands
// to two patterns; a PatternMatcher is already one. Used by the script-injector to
// register content scripts against URL patterns (not per-URL).
//
// A RegexMatcher has no pattern form — no finite set of match patterns describes an
// arbitrary regex — so this throws rather than inventing a wider one: `*://*/*` would
// inject the user's snippet into every page they open. `config/parse` is what keeps it
// unreachable, by refusing `scripts` on a rule whose match list contains a regex.
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
