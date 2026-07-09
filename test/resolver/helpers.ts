import type { Config, Deps, NavContext, Rule, Group, ContainerRef } from "../../src/resolver/types";

// Extract the hostname from a URL.
export function host(url: string): string {
  return new URL(url).host;
}

// A test Matcher is a bare hostname; it matches a URL whose host equals it or is a
// subdomain of it (shorthand-subtree semantics). NOT the production matcher.
function matcherHits(m: unknown, url: string): boolean {
  const h = host(url);
  const bare = String(m);
  return h === bare || h.endsWith("." + bare);
}

function anyMatch(matchers: unknown[], url: string): boolean {
  return matchers.some((m) => matcherHits(m, url));
}

// last two dot-labels, e.g. "old.reddit.com" -> "reddit.com"
function lastTwoLabels(h: string): string {
  return h.split(".").slice(-2).join(".");
}

export function makeDeps(): Deps {
  return {
    matchRule: (url: string, rules: Rule[]): Rule | null =>
      rules.find((r) => anyMatch(r.match, url)) ?? null,
    matchGroup: (url: string, groups: Group[]): number | null => {
      const i = groups.findIndex((g) => anyMatch(g.match, url));
      return i === -1 ? null : i;
    },
    sameSite: (a: string, b: string): boolean =>
      lastTwoLabels(host(a)) === lastTwoLabels(host(b)),
  };
}

// Convenience constructors for readable test cases.
export function config(rules: Rule[] = [], groups: Group[] = []): Config {
  return { rules, groups };
}

export function nav(
  targetUrl: string,
  current: { url: string; container: ContainerRef } | null = null,
  initiator: ContainerRef | null = null,
): NavContext {
  return { targetUrl, current, initiator };
}

// ContainerRef shorthands.
export const def: ContainerRef = { kind: "default" };
export const temp: ContainerRef = { kind: "temporary" };
export const perm = (name: string): ContainerRef => ({ kind: "permanent", name });
