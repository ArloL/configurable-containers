// Pure resolver types. No browser, no I/O. See
// docs/superpowers/specs/2026-07-10-l1-resolver-design.md §2–§3.

// Opaque to resolve(): only the injected matchRule/matchGroup interpret it. A bare
// hostname string in L1 tests, the L2 match grammar in production.
export type Matcher = unknown;

export type Action =
  | { kind: "open"; containers: string[]; default?: string } // 1+ names; "Temporary" reserved
  | { kind: "inherit" }
  | { kind: "ignore" }
  | { kind: "redirector" };

// browser.cookies.set minus storeId, which the seeder forces to the tab's own store
// (cookies-overlay design spec §5). resolve() ignores it; the cookie-seeder consumes it.
export interface CookieSpec {
  name: string;
  url: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "no_restriction" | "lax" | "strict";
  expirationDate?: number;
  firstPartyDomain?: string;
  partitionKey?: { topLevelSite?: string };
}

// The browser.contentScripts.register js/runAt surface. resolve() ignores it; the
// script-injector consumes it (scripts-overlay design spec §5).
export interface ScriptSpec {
  run: string; // inline JS source, not a file
  at?: "document_start" | "document_end" | "document_idle"; // default "document_start"
}

export interface Rule {
  match: Matcher[]; // normalized to a list (single -> [single])
  action: Action;
  cookies?: CookieSpec[];
  scripts?: ScriptSpec[];
}

export interface Group {
  match: Matcher[];
}

export interface Config {
  rules: Rule[];
  groups: Group[];
}

export type ContainerRef =
  | { kind: "default" }
  | { kind: "permanent"; name: string }
  | { kind: "temporary" }; // throwaway; identity is irrelevant to the decision

export interface NavContext {
  targetUrl: string;
  current: { url: string; container: ContainerRef } | null; // null = blank/new tab
  initiator: ContainerRef | null;
  // The page this tab's container came from: where a link was clicked, for a tab the
  // browser opened FOR that click and put in the clicked page's container. Null when the
  // tab has a page of its own (`current` is then the better answer), and null when the tab
  // is NOT in its opener's container — an extension can open a tab anywhere and still name
  // an opener, and then the opener's page says nothing about this tab.
  //
  // Only the disposable path reads it, only to ask whether this navigation may keep the
  // throwaway it is in. Deliberately NOT `current`: a tab with no page is not "already
  // correctly contained" in anything, and treating the opener's page as its own would
  // silence the choice screen on a tab's first navigation (how F14's chain opens).
  inheritedFrom: { url: string; container: ContainerRef } | null;
}

export interface Deps {
  matchRule: (url: string, rules: Rule[]) => Rule | null; // first-match
  matchGroup: (url: string, groups: Group[]) => number | null; // first-match group index
  sameSite: (a: string, b: string) => boolean; // PSL registrable-domain equality
}

// Structurally identical to ContainerRef; named separately for intent — where to reopen a
// tab, versus where it is.
export type Target =
  | { kind: "default" }
  | { kind: "permanent"; name: string }
  | { kind: "temporary" }; // a FRESH throwaway; reuse is expressed as "stay"

export type Decision =
  | { kind: "leaveAlone" }
  | { kind: "stay" }
  | { kind: "reopen"; into: Target }
  | { kind: "choice"; options: string[] };

// The reserved container name meaning "a fresh throwaway".
export const TEMPORARY = "Temporary";
