// Bare-hostname matcher. Pure, no I/O. See
// docs/superpowers/specs/2026-07-10-l2-matcher-design.md §2–§3.

import type { Rule, Group } from "../resolver/types";

export type HostMatcher = { kind: "host"; host: string }; // host is the CANONICAL form
export type Matcher = HostMatcher; // extensible later: | PatternMatcher | RegexMatcher

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

// The canonical host of an http/https URL, or null if it is not an http(s) URL with
// a host (never throws).
function urlHost(url: string): string | null {
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
  return stripTrailingDot(u.hostname);
}

export function hostMatcher(host: string): HostMatcher {
  return { kind: "host", host: canonicalHost(host) };
}

export function matches(m: Matcher, url: string): boolean {
  const h = urlHost(url);
  if (h === null) return false;
  switch (m.kind) {
    case "host":
      return h === m.host || h.endsWith("." + m.host);
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

// The WebExtension match patterns that exactly cover a matcher's matches() semantics
// for http(s). A HostMatcher { host } matches the bare host OR any subdomain, so it
// expands to two patterns: *://<host>/* and *://*.<host>/*. Used by the script-injector
// to register content scripts against URL patterns (not per-URL).
export function matcherToPatterns(m: Matcher): string[] {
  switch (m.kind) {
    case "host":
      return [`*://${m.host}/*`, `*://*.${m.host}/*`];
  }
}
