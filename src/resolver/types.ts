// Pure resolver types. No browser, no I/O. See
// docs/superpowers/specs/2026-07-10-l1-resolver-design.md §2–§3.

// A Matcher is opaque to resolve(): only the injected matchRule/matchGroup
// interpret it. In L1 tests it is a bare hostname string; in production it will be
// the richer L2 match grammar.
export type Matcher = unknown;

export type Action =
  | { kind: "open"; containers: string[]; default?: string } // 1+ names; "Temporary" reserved
  | { kind: "inherit" }
  | { kind: "ignore" }
  | { kind: "redirector" };

export interface Rule {
  match: Matcher[]; // normalized to a list (single -> [single])
  action: Action;
  // overlays (cookies/scripts) may exist on the real rule but resolve() ignores them
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
}

export interface Deps {
  matchRule: (url: string, rules: Rule[]) => Rule | null; // first-match
  matchGroup: (url: string, groups: Group[]) => number | null; // first-match group index
  sameSite: (a: string, b: string) => boolean; // PSL registrable-domain equality (injected)
}

// Structurally identical to ContainerRef (default | permanent | temporary); named
// separately for intent (where to reopen a tab, vs where it currently is).
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
