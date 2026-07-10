// Bare-hostname matcher. Pure, no I/O. See
// docs/superpowers/specs/2026-07-10-l2-matcher-design.md §2–§3.

export type HostMatcher = { kind: "host"; host: string }; // host is the CANONICAL form
export type Matcher = HostMatcher; // extensible later: | PatternMatcher | RegexMatcher

// Canonicalize a hostname string: lowercase + punycode + drop a trailing dot, via
// the URL parser. Throws if the input is not a bare hostname (has a scheme, path,
// port, whitespace, or is empty).
function canonicalHost(hostish: string): string {
  if (hostish === "" || /[\s/\\?#@:]/.test(hostish)) {
    throw new Error(`not a bare hostname: ${JSON.stringify(hostish)}`);
  }
  let u: URL;
  try {
    u = new URL("http://" + hostish + "/");
  } catch {
    throw new Error(`not a bare hostname: ${JSON.stringify(hostish)}`);
  }
  // Reject anything the parser reinterpreted (userinfo, port, non-empty path is
  // impossible here since we appended "/"; hostname must equal the whole input).
  if (u.hostname === "" || u.port !== "") {
    throw new Error(`not a bare hostname: ${JSON.stringify(hostish)}`);
  }
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
