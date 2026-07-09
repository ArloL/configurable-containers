# L1 Resolver — Design

**Date:** 2026-07-10
**Status:** Approved, pending implementation plan
**Topic:** The pure routing-decision function at the base of the TESTING.md pyramid.

## 1. Goal & scope

Build the **pure `resolve()` decision function** — the heart of the routing
engine. Given a navigation context and a normalized config, it returns a
`Decision` describing what should happen to the tab. No `browser.*`, no clock, no
I/O. This is where almost all subtle logic lives (F3–F6, F11 routing side) and
where CONFIG.md/TESTS.md become code.

The design goal (TESTING.md): keep the **decision** a pure function and the
**effects** behind a *thin* adapter. This slice is that pure function.

### In scope

- `resolve(nav, config, deps): Decision` and its types.
- The composed three-mechanism algorithm (rule enforcement → temporary same-site
  continuity → exemptions), with continuity (reuse-vs-new temp) resolved **inside**
  `resolve()`.
- Table-driven + property-based (fast-check) tests.

### Out of scope (deferred to sibling slices)

- The **matcher** (URL → pattern; hostname shorthand, WebExtension match patterns,
  regex, any-of lists) — L2, injected here as `Deps.matchRule` / `Deps.matchGroup`,
  with deterministic test doubles.
- The real **PSL same-site** check — injected here as `Deps.sameSite`, test double now.
- The **config parser** (format YAML/JSON/… is undecided). `resolve()` consumes a
  typed, already-normalized `Config`.
- **Overlays** (`cookies`/`scripts`) and the **redirector auto-close** timing —
  side-effects the adapter applies from the matched rule; tested at L3/L4. L1 is the
  container decision only.

## 2. Signature & inputs

```ts
resolve(nav: NavContext, config: Config, deps: Deps): Decision

interface NavContext {
  targetUrl: string;
  current: { url: string; container: ContainerRef } | null; // tab's current URL+container; null = blank/new tab
  initiator: ContainerRef | null;                           // container that initiated the nav (for inherit)
}

type ContainerRef =
  | { kind: "default" }                    // firefox-default (no container)
  | { kind: "permanent"; name: string }    // a named container
  | { kind: "temporary" };                 // some throwaway (its identity is irrelevant to the decision)

interface Deps {
  matchRule:  (url: string, rules:  Rule[])  => Rule  | null;  // first-match; L2 matcher, injected
  matchGroup: (url: string, groups: Group[]) => number | null; // first-match group index
  sameSite:   (a: string, b: string) => boolean;               // PSL registrable-domain equality, injected
}
```

`Config` is a **typed, normalized object** (parsing/format out of scope):

```ts
interface Config {
  rules: Rule[];
  groups: Group[];
}

// A normalized rule carries its matchers plus exactly one action.
interface Rule {
  match: Matcher[];          // normalized to a list (single -> [single])
  action: Action;
  // overlays (cookies/scripts) may exist on the rule but are ignored by resolve()
}

type Action =
  | { kind: "open"; containers: string[]; default?: string }  // 1+ names; "Temporary" is a reserved name
  | { kind: "inherit" }
  | { kind: "ignore" }
  | { kind: "redirector" };

interface Group { match: Matcher[]; }

type Matcher = /* opaque to resolve(); interpreted only by injected matchRule/matchGroup */ unknown;
```

Notes:
- **Auto-naming** (`- match: bandcamp.com` → container `bandcamp.com`) is normalized
  *before* `resolve()` into `action: { kind: "open", containers: ["bandcamp.com"] }`.
  The normalizer (part of config loading, not L1) derives the name from the first
  plain-hostname matcher. `resolve()` never auto-names; it always sees explicit
  `open` containers.
- `"Temporary"` is a reserved container name (not a real container). It may appear
  in `containers` and/or `default`.

## 3. Decision type

The reuse-vs-new-temp distinction collapses into **stay vs reopen** — "keep the
current throwaway" *is* "stay". "Already correctly contained" is also `stay`, so
the F1/F2 reopen-loop guard is structural.

```ts
type Decision =
  | { kind: "leaveAlone" }                  // ignore rule: engine does nothing
  | { kind: "stay" }                        // already in the correct container; no reopen
  | { kind: "reopen"; into: Target }        // reopen the tab into a different container
  | { kind: "choice"; options: string[] };  // multi-open, no default, not already eligible

type Target =
  | { kind: "default" }                     // reopen into no container (firefox-default)
  | { kind: "permanent"; name: string }
  | { kind: "temporary" };                  // a FRESH throwaway (reuse is expressed as "stay")
```

`Target` is structurally identical to `ContainerRef` (default | permanent |
temporary), so "reopen into the initiator's container" is just `reopen{into:
initiator}`. They are kept as distinct type names for intent (where a tab *is* vs
where to reopen it).

`Decision` is a discriminated union and is exhaustively switched (no `default`
case) so a new variant fails to compile until handled (TESTING.md static gate).

## 4. Algorithm — the three mechanisms, composed

Compute a **desired container**, then diff against `current` → `stay` or `reopen`.

1. `rule = matchRule(targetUrl, config.rules)` (first-match; `null` if none).
2. **`ignore`** → `{ kind: "leaveAlone" }`. Done.
3. **`redirector`** → the hop is not isolated → desired = current container → `stay`.
   (The conditional auto-close is a later lifecycle level, not this decision.)
4. **`inherit`** → desired = `nav.initiator` (fall back to `current.container`; if
   both null — inherit from a blank tab with no initiator — desired = `default`).
   Then diff (step 8) → `stay` or `reopen{into: desired}`.
   **Temporary-identity limitation:** L1 `ContainerRef.temporary` carries no id, so
   two temporaries compare equal. The founding `inherit` cases are same-tab auth
   hops where `current` already *is* the initiator's throwaway → `stay` (correct).
   The rare cross-tab case (initiator is a *different* throwaway than `current`)
   would `reopen{into: temporary}` = a *fresh* one, losing the initiator's specific
   throwaway. Accepted for L1; if it ever matters, `temporary` gains an id.
5. **`open`** with a single container `X`:
   - `X === "Temporary"` → **disposable path** (step 7).
   - else desired = `{ permanent: X }`.
6. **`open`** with multiple containers (eligible = the listed names):
   - If `current.container` is a permanent whose name ∈ eligible → `stay`
     ("no prompt when already in an eligible container").
   - Else if `default` is set:
     - `default === "Temporary"` → disposable path (step 7).
     - else desired = `{ permanent: default }`.
   - Else (no default) → `{ kind: "choice", options: eligible }` (the listed
     containers as configured; a literal `"Temporary"` stays a selectable option).
     If the current container already satisfies eligibility it was caught above, so
     a choice never re-prompts when already eligible.

   **Open edge (flagged, not blocking):** whether a *current temporary* container
   should count as "already eligible" against a listed `"Temporary"` in a no-default
   multi-open (i.e. `stay` vs re-`choice`). This slice treats only permanent-name
   membership as auto-eligible and sends the temporary case to `choice`; revisit if
   a real config needs `[Temporary, X]` without a default (none exists today).
7. **Disposable path** (no rule matched, or the resolved container is `Temporary`):
   - If `current.container.kind === "temporary"` **and**
     `sameContinuityScope(current.url, targetUrl)` → `stay` (keep the throwaway).
   - Else desired = `{ kind: "temporary" }` (fresh).
   - `sameContinuityScope(a, b) = deps.sameSite(a, b) || sameGroup(a, b)` where
     `sameGroup(a, b) = matchGroup(a) !== null && matchGroup(a) === matchGroup(b)`.
     Group membership is looked up **by URL only**, independent of routing (the F4
     constraint; enables the age-gate chain where `accounts.google.com` reached via
     `inherit` still counts in the google group).
8. **Diff**: if `desired` equals `current.container` (same kind and, for permanent,
   same name) → `stay`; otherwise `{ kind: "reopen", into: desired }`.
   - A `temporary` desired always `reopen`s (a *fresh* throwaway) — step 7 already
     handled the reuse-current case as `stay`, so reaching the diff with a temporary
     desired means "new".

### Worked check: the age-gate chain (F4 end-to-end)

`accounts.google.com` (in temp **T**) → `youtube.com`, with `youtube.com` on an
`open:[Temporary,Personal] default:Temporary` rule and both in the google group:
step 6 → default `Temporary` → step 7; `current.container` is temporary **T**, and
`sameGroup(accounts.google.com, youtube.com)` is true → `stay` in **T**. Correct.

## 5. Internal decomposition

- `matchRule` / `matchGroup` — injected (`Deps`); real L2 matcher later, deterministic
  doubles now.
- `sameSite` — injected; real PSL later, double now.
- `resolve` — the only place mechanisms combine. Small helpers (`disposablePath`,
  `sameContinuityScope`, `sameContainer(a,b)`) may be module-private pure functions.

## 6. Testing (L1)

**Table-driven** (`resolve.test.ts`) — one case per pure-routing TESTS.md scenario
and per known edge:
- rule enforcement overrides same-site continuity (`www.google.com` → `mail.google.com`);
- auto-named (post-normalization) single `open`;
- multi-open with default (auto-open) / without default (choice) / already-eligible (stay);
- `inherit` stays put; `inherit` from temp stays temp;
- `ignore` leaveAlone; blank-tab `ignore` stays default;
- group continuity (member↔member stay; enter/leave group isolate);
- a domain in both a rule and a group keeps membership (age-gate);
- precedence: first matching rule wins; rules and groups never shadow.

**Property-based** (`resolve.props.test.ts`, fast-check generates configs + navs):
- *First-match determinism* — `matchRule` equals a "scan in order, take first" oracle. (F5)
- *Group totality* — every URL resolves to ≤1 group; membership is a function of URL
  only (permuting `initiator`/`current` never changes it). (F4)
- *Independence* — changing a rule's `open` target never changes any group answer. (F4/F5)
- *`inherit` neutrality* — an `inherit` match never yields `temporary` or `permanent`;
  for fixed `initiator` its result is invariant under the rest of the config. (F6)
- *Continuity monotonicity* — same registrable domain (or same group) ⇒ never a fresh
  temp; different site **and** different group ⇒ always `reopen{temporary}`. (F3)

Determinism: seeded fast-check; a failing property prints its seed. No clock, no I/O.

## 7. File structure

```
src/resolver/types.ts     Config, Rule, Group, Action, Matcher, NavContext,
                          ContainerRef, Decision, Target, Deps
src/resolver/resolve.ts   resolve() + module-private helpers
test/resolver/resolve.test.ts         table-driven examples
test/resolver/resolve.props.test.ts   fast-check properties
```

Toolchain is the repo's existing TS + Vitest; add `fast-check` as a devDependency.
`tsconfig.json` `include` gains `src`. The `Decision`/`Action` unions are
exhaustively switched (no `default`) so new variants fail `tsc`.

## 8. What this slice does *not* prove

Routing decisions only — not their execution. Reopen/create/dispose effects, MV3
restart resilience, real event ordering, overlays timing, and the redirector
auto-close are later levels. The value is a **pure, exhaustively-tested decision
core** the adapter and the higher levels build on.
