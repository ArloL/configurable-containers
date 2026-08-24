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

// The site a URL belongs to, as one comparable value: its registrable domain, or, for a
// host with none (IP, localhost, a bare public suffix), the tagged hostname. Null when
// there is no host at all, and null is the same site as nothing — not even another
// hostless URL.
//
// One value rather than a pair of domains keeps "exactly one has a domain" from needing its
// own branch: written as branches there were four ways to spell it that all behaved alike,
// and no test could tell them apart. One tldts.parse() gives both halves.
function site(url: string): string | null {
  const p = parse(url, OPTS);
  if (p.domain !== null) return p.domain;
  // Stryker disable next-line StringLiteral: the tag prevents a collision that cannot
  // happen — a host with no registrable domain and one whose domain is that same string
  // would be the same host, and would have parsed the same way. It labels; it decides
  // nothing.
  return p.hostname === null ? null : "host:" + p.hostname;
}

// Same-site iff the two URLs belong to the same site. Total (never throws); tldts
// lowercases hostnames, so this is case-insensitive.
export function sameSite(a: string, b: string): boolean {
  const sa = site(a);
  return sa !== null && sa === site(b);
}
