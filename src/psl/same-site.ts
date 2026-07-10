// Registrable-domain (eTLD+1) same-site check via the Public Suffix List, private
// section honoured. Pure, no network. See
// docs/superpowers/specs/2026-07-10-psl-samesite-design.md §3–§4.
import { parse } from "tldts";

const OPTS = { allowPrivateDomains: true } as const;

// The registrable domain of a URL/hostname (private suffixes honoured), or null when
// there is none (IP, single-label host, bare public suffix, invalid).
export function registrableDomain(url: string): string | null {
  return parse(url, OPTS).domain;
}

// Same-site iff same registrable domain; for null-domain hosts (IP/localhost/etc.)
// fall back to exact hostname equality (tldts already lowercases the hostname). Total
// (never throws). One tldts.parse() per URL yields both the domain and the hostname.
export function sameSite(a: string, b: string): boolean {
  const pa = parse(a, OPTS);
  const pb = parse(b, OPTS);
  if (pa.domain !== null && pb.domain !== null) return pa.domain === pb.domain;
  if (pa.domain === null && pb.domain === null) {
    return pa.hostname !== null && pa.hostname === pb.hostname;
  }
  return false; // exactly one has a registrable domain
}
