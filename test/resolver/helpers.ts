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

export function realMatchers(): Deps {
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
export function aConfigOf(rules: Rule[] = [], groups: Group[] = []): Config {
  return { rules, groups };
}

export function aNavigation(
  targetUrl: string,
  current: { url: string; container: ContainerRef } | null = null,
  initiator: ContainerRef | null = null,
  inheritedFrom: { url: string; container: ContainerRef } | null = null,
): NavContext {
  return { targetUrl, current, initiator, inheritedFrom };
}

// A link opened in a NEW tab: the tab has no page of its own and sits in the container
// of the page the click came from, which is the only thing that says where it came from.
export function aNavigationFromALinkOn(
  clickedPage: { url: string; container: ContainerRef },
  targetUrl: string,
): NavContext {
  return { targetUrl, current: null, initiator: clickedPage.container, inheritedFrom: clickedPage };
}

// ContainerRef shorthands.
export const theDefaultContainer: ContainerRef = { kind: "default" };
export const aThrowaway: ContainerRef = { kind: "temporary" };
export const theContainerNamed = (name: string): ContainerRef => ({ kind: "permanent", name });
