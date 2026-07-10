# Config Parser (YAML → Config) — Design

**Date:** 2026-07-10
**Status:** Approved, pending implementation plan
**Topic:** Parse + normalize + validate the user's YAML config into the resolver's `Config`.

## 1. Goal & scope

`parseConfig(yamlText): Config` turns the user-edited YAML into the resolver's
`Config` (`{ rules, groups }`), building matchers with L2's `hostMatcher` and applying
**auto-naming**. Throws a `ConfigError` (message + location) on invalid input.

### In scope

- YAML parse via **`yaml` (eemeli)**.
- Rule normalization: `match` → `Matcher[]`; the at-most-one action
  (`open`/`inherit`/`ignore`/`redirector`); **auto-naming** (no action → `open:
  [firstHost]`).
- Groups: list-of-lists of bare hosts → `Group[]`.
- Validation with clear errors (syntax → line/col; semantic → path + message).
- Table tests + a **real-config** integration test parsing
  `configurable-containers.config.yaml`.

### Out of scope (deferred)

- **Match-patterns / regex** match grammars — L2 only has bare-hostname matching
  today, so those `match` forms raise a clear `ConfigError`. (The real config uses
  only bare hosts.)
- **Overlays** (`cookies` / `scripts`) — **accepted but not surfaced.** The parser
  tolerates these keys (does not error, does not treat them as unknown) but does not
  put them in the returned `Config`; nothing consumes overlays yet (no adapter). A
  later adapter slice extends the parser to surface + validate them. No data is lost:
  the YAML file remains the source of truth. `Config`/`Rule` types are unchanged.
- **Config source/IO** (reading the file from disk / storage) and the built-in
  editor — the parser takes a string.
- Upgrading **semantic** errors to line/col — path-based messages ship now; AST-range
  mapping is a follow-up.

## 2. Interface

```ts
// src/config/parse.ts
import type { Config } from "../resolver/types";

export class ConfigError extends Error {
  readonly path?: string;              // e.g. "rules[3].default"
  readonly line?: number;              // 1-based, when known (syntax errors)
  readonly col?: number;
  constructor(message: string, opts?: { path?: string; line?: number; col?: number });
}

// Parse + normalize + validate. Throws ConfigError on any invalid input.
export function parseConfig(yamlText: string): Config;
```

`Config` is unchanged: `{ rules: Rule[]; groups: Group[] }`,
`Rule = { match: Matcher[]; action: Action }`, `Group = { match: Matcher[] }`, with
matchers built by `hostMatcher()` (opaque `Matcher` at the resolver boundary).

## 3. Grammar → `Config` mapping

Top level: a YAML mapping with optional `rules` (sequence) and `groups` (sequence).
Missing → empty list. A non-mapping top level, or `rules`/`groups` that aren't
sequences → `ConfigError`.

### Rules

Each rule is a mapping. Keys:

- **`match`** (required): a string or a non-empty sequence of strings. Normalized to a
  list. Each entry must be a **bare hostname** → `hostMatcher(entry)`. An entry that
  contains a scheme/`/`/glob (looks like a match pattern) or is a mapping with a
  `regex` key → `ConfigError` ("bare hostnames only for now"). `hostMatcher`'s own
  validation errors are re-raised as `ConfigError` with the rule path.
- **Action** — at most one of:
  - *(none)* → **auto-name**: `action = { kind: "open", containers: [firstHost] }`,
    where `firstHost` is the canonical host of the **first** `match` entry.
  - **`open: X`** (string) → `{ kind: "open", containers: [X] }`.
  - **`open: [A, B, …]`** (sequence, len ≥ 1) → `{ kind: "open", containers: [A, B, …] }`.
  - **`inherit: true`** → `{ kind: "inherit" }`.
  - **`ignore: true`** → `{ kind: "ignore" }`.
  - **`redirector: true`** → `{ kind: "redirector" }`.
  - Two or more action keys present → `ConfigError` ("a rule has at most one action").
- **`default`** (optional): only valid with a **multi**-value `open` (len ≥ 2); must be
  one of that `open`'s containers (the reserved `Temporary` counts if listed). Attached
  as `action.default`. `default` without `open`, with single `open`, or naming a
  non-listed container → `ConfigError`.
- **`cookies`, `scripts`** (optional): **tolerated, ignored** (not surfaced). Present
  on the key allowlist so they don't trip "unknown key".
- Any **other key** → `ConfigError` ("unknown key `foo` in rules[i]").

`Temporary` is passed through verbatim in `containers` / `default`; the resolver
interprets it. (No permanent container may be *named* `Temporary`, but that's the
resolver's concern; the parser just carries the string.)

### Groups

`groups` is a sequence; each group is a **sequence of bare-host strings** →
`Group { match: [hostMatcher(h), …] }`. A non-sequence group, an empty group, or a
pattern/regex entry → `ConfigError`. (Groups take the same matcher grammar as rules,
but only bare hosts are supported now.)

## 4. Validation summary

| Case | Result |
|---|---|
| YAML syntax error | `ConfigError` with **line/col** (from `yaml`) |
| top level not a mapping | `ConfigError` |
| `rules`/`groups` not a sequence | `ConfigError` |
| rule missing `match` / empty `match` | `ConfigError` (path `rules[i].match`) |
| `match` entry not a bare host (pattern/regex) | `ConfigError` ("bare hostnames only for now") |
| ≥ 2 action keys | `ConfigError` ("at most one action") |
| `open: []` (empty) | `ConfigError` |
| `default` without/at single `open` | `ConfigError` |
| `default` not in `open` list | `ConfigError` (path `rules[i].default`) |
| unknown key | `ConfigError` (names the key + path) |
| group not a sequence / empty / pattern entry | `ConfigError` (path `groups[i]`) |

Semantic errors carry a `path`; syntax errors carry `line`/`col`.

## 5. Dependency

`yaml` (eemeli) → **`dependencies`** (runtime; the extension parses config live).
Refreshed by Renovate like tldts.

## 6. Testing

**Table** (`test/config/parse.test.ts`):
- Each rule form → expected `Config` (deep-equal on the normalized rules, comparing
  matchers via `hostMatcher(...)` values): auto-named single host, auto-named
  multi-host (named after first), `open` single, `open` multi (choice), `open` +
  `default`, `open: Temporary`, `inherit`, `ignore`, `redirector`.
- Overlays tolerated: a rule with `cookies`/`scripts` parses (routing surfaced,
  overlays absent from the result), no error.
- Groups: list-of-lists → `Group[]`.
- Each validation error row from §4 → asserts `ConfigError` thrown with the expected
  `path` / message substring (and, for a syntax case, that `line` is set).

**Real-config integration** (`test/config/parse.real.test.ts`):
Read `configurable-containers.config.yaml` from the repo root and `parseConfig` it:
- Does not throw; returns a `Config`.
- Spot-checks: `adventofcode.com` rule is auto-named (`open: [adventofcode.com]`); the
  `Haeger` rule maps its 4 hosts to `open: [Haeger]`; `outlook.cloud.microsoft` →
  `open: [Haeger, HSP]` (no default); a `login.microsoftonline.com`/`accounts.google.com`
  rule is `inherit`; `getpocket.com` is `ignore`; the `t.co` list is `redirector`;
  `youtube.com` is `open: [Temporary]` (its `cookies`/`scripts` tolerated); groups
  include the google and microsoft sets.
- A count assertion (rules length / groups length) to catch silent drops.

## 7. What this slice does *not* prove

Parsing the routing model from YAML. It does not surface overlays, support
match-patterns/regex, read the file from disk, or wire the resulting `Config` into a
live extension. After this slice, a real config file can be turned into a resolver
`Config`; assembling live `Deps` + `Config` and driving `resolve()` from Firefox
events is the extension-entry slice.
