// Pure overlay core: which cookies apply to a URL, and Cookie-header (de)serialization.
// No browser, no I/O. Consumed by the cookie-seeder (src/engine/cookie-seeder.ts).
import type { Config, CookieSpec, Deps } from "../resolver/types";

// A single HTTP request/response header. Re-exported from src/engine/port.ts so the
// port seam and this pure module share one definition.
export interface HttpHeader {
  name: string;
  value?: string;
}

// The cookies to seed for `url`: the first matching rule's overlay, or [] when no
// rule matches or the matched rule is `ignore`. Routed through the SAME injected
// matchRule as the router, so overlay precedence can never drift from routing.
export function cookiesFor(url: string, config: Config, matchRule: Deps["matchRule"]): CookieSpec[] {
  const rule = matchRule(url, config.rules);
  if (!rule || rule.action.kind === "ignore") return [];
  return rule.cookies ?? [];
}

// Parse a request's `Cookie` header into a { name: value } jar (empty if absent).
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

// Return a new header array with the `Cookie` header rebuilt from the jar (any
// existing Cookie header, whatever its casing, is dropped and one canonical
// `Cookie` header appended).
export function writeCookieHeader(headers: HttpHeader[], jar: Record<string, string>): HttpHeader[] {
  const value = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const out = headers.filter((h) => h.name.toLowerCase() !== "cookie");
  out.push({ name: "Cookie", value });
  return out;
}
