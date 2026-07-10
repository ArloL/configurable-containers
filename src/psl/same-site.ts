// Registrable-domain (eTLD+1) same-site check via the Public Suffix List, private
// section honoured. Pure, no network. See
// docs/superpowers/specs/2026-07-10-psl-samesite-design.md §3–§4.
import { getDomain, getHostname } from "tldts";

const OPTS = { allowPrivateDomains: true } as const;

// The registrable domain of a URL/hostname (private suffixes honoured), or null when
// there is none (IP, single-label host, bare public suffix, invalid).
export function registrableDomain(url: string): string | null {
  return getDomain(url, OPTS);
}

// Lowercased hostname, or null. Never throws.
function hostname(url: string): string | null {
  const h = getHostname(url, OPTS);
  return h === null ? null : h.toLowerCase();
}

// Same-site iff same registrable domain; for null-domain hosts (IP/localhost/etc.)
// fall back to exact hostname equality. Total (never throws).
export function sameSite(a: string, b: string): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  if (da !== null && db !== null) return da === db;
  if (da === null && db === null) {
    const ha = hostname(a);
    const hb = hostname(b);
    return ha !== null && ha === hb;
  }
  return false; // exactly one has a registrable domain
}
