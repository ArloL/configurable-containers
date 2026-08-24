// Pure: no browser, no I/O. Consumed by src/engine/cookie-seeder.ts.
import type { Config, CookieSpec, Deps } from "../resolver/types";

// Re-exported from src/engine/port.ts so the port seam and this pure module share one
// definition.
export interface HttpHeader {
  name: string;
  value?: string | undefined;
}

// [] when nothing matches or the match is `ignore`. Goes through the SAME injected
// matchRule as the router, so overlay precedence cannot drift from routing.
export function cookiesFor(url: string, config: Config, matchRule: Deps["matchRule"]): CookieSpec[] {
  const rule = matchRule(url, config.rules);
  // Stryker disable next-line all: the `ignore` half is unreachable from a parsed config
  // — `config/parse` refuses `cookies:` on an `ignore` rule outright, so a matched ignore
  // rule has no cookies to return either way. Kept as the second line of defence, since
  // "ignore means CC does not touch this site" is this function's contract and not the
  // parser's.
  if (!rule || rule.action.kind === "ignore") return [];
  return rule.cookies ?? [];
}

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

// Any existing `Cookie` header is dropped whatever its casing, and one canonical header
// appended.
export function writeCookieHeader(headers: HttpHeader[], jar: Record<string, string>): HttpHeader[] {
  const value = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const out = headers.filter((h) => h.name.toLowerCase() !== "cookie");
  out.push({ name: "Cookie", value });
  return out;
}
