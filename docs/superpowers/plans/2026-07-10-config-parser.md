# Config Parser (YAML → Config) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `parseConfig(yamlText): Config` — parse + normalize + validate the YAML config into the resolver's `Config`, with auto-naming and clear `ConfigError`s.

**Architecture:** `yaml` (eemeli) parses text → JS; the parser maps rules/groups to the resolver `Config`, building matchers with L2's `hostMatcher`, applying auto-naming, tolerating (ignoring) `cookies`/`scripts` overlays, and rejecting invalid input with a `ConfigError` (path for semantic errors, line/col for syntax). Match-patterns/regex are rejected (bare hosts only for now).

**Tech Stack:** TypeScript, Vitest (in repo); **yaml** (new runtime dependency).

**Spec:** `docs/superpowers/specs/2026-07-10-config-parser-design.md` — read §3–§4.

---

## File structure

| File | Responsibility |
|---|---|
| `src/config/parse.ts` | `ConfigError`, `parseConfig()`, and private rule/group/match helpers. |
| `test/config/parse.test.ts` | Table: rule forms + rule validation errors + empty config. |
| `test/config/parse.groups.test.ts` | Group parsing + group validation. |
| `test/config/parse.real.test.ts` | Parses the real `configurable-containers.config.yaml`. |

`src/resolver/types.ts` is unchanged (`Config`/`Rule`/`Action` reused; `Matcher` stays opaque).

---

## Task 1: yaml dep + `parseConfig` (rules + top-level + validation)

**Files:**
- Modify: `package.json` (add `yaml` to `dependencies`)
- Create: `src/config/parse.ts`
- Test: `test/config/parse.test.ts`

- [ ] **Step 1: Add `yaml` as a runtime dependency**

`package.json` already has a `dependencies` object (with `tldts`). Add `yaml`:
```json
  "dependencies": {
    "tldts": "^6.1.0",
    "yaml": "^2.5.0"
  },
```
Run `npm install`. Expected: succeeds; `yaml` present. Report the installed version.

- [ ] **Step 2: Write the failing tests**

`test/config/parse.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/config/parse";
import { hostMatcher as hm } from "../../src/matcher/matcher";

describe("parseConfig — rule forms", () => {
  it("auto-names a bare single-host rule", () => {
    const c = parseConfig(`rules:\n  - match: adventofcode.com\n`);
    expect(c).toEqual({
      rules: [{ match: [hm("adventofcode.com")], action: { kind: "open", containers: ["adventofcode.com"] } }],
      groups: [],
    });
  });

  it("auto-names a multi-host rule after the first host", () => {
    const c = parseConfig(`rules:\n  - match: [notion.com, notion.so]\n`);
    expect(c.rules[0]).toEqual({
      match: [hm("notion.com"), hm("notion.so")],
      action: { kind: "open", containers: ["notion.com"] },
    });
  });

  it("parses open single / multi / default and Temporary passthrough", () => {
    const c = parseConfig(
      `rules:\n` +
        `  - match: goflink.com\n    open: Flink\n` +
        `  - match: figma.com\n    open: [Personal, Work]\n` +
        `  - match: trello.com\n    open: [Personal, Work]\n    default: Work\n` +
        `  - match: pinterest.com\n    open: Temporary\n`,
    );
    expect(c.rules[0].action).toEqual({ kind: "open", containers: ["Flink"] });
    expect(c.rules[1].action).toEqual({ kind: "open", containers: ["Personal", "Work"] });
    expect(c.rules[2].action).toEqual({ kind: "open", containers: ["Personal", "Work"], default: "Work" });
    expect(c.rules[3].action).toEqual({ kind: "open", containers: ["Temporary"] });
  });

  it("parses inherit / ignore / redirector", () => {
    const c = parseConfig(
      `rules:\n` +
        `  - match: accounts.google.com\n    inherit: true\n` +
        `  - match: getpocket.com\n    ignore: true\n` +
        `  - match: [t.co, slack-redir.net]\n    redirector: true\n`,
    );
    expect(c.rules[0].action).toEqual({ kind: "inherit" });
    expect(c.rules[1].action).toEqual({ kind: "ignore" });
    expect(c.rules[2].action).toEqual({ kind: "redirector" });
    expect(c.rules[2].match).toEqual([hm("t.co"), hm("slack-redir.net")]);
  });

  it("tolerates cookies/scripts overlays without surfacing them", () => {
    const c = parseConfig(
      `rules:\n  - match: youtube.com\n    open: Temporary\n` +
        `    cookies:\n      - { name: wide, url: "https://www.youtube.com/", value: "1" }\n`,
    );
    expect(c.rules[0]).toEqual({ match: [hm("youtube.com")], action: { kind: "open", containers: ["Temporary"] } });
  });

  it("returns empty config for empty / comment-only input", () => {
    expect(parseConfig("")).toEqual({ rules: [], groups: [] });
    expect(parseConfig("# just a comment\n")).toEqual({ rules: [], groups: [] });
  });
});

describe("parseConfig — rule validation", () => {
  function err(yaml: string): ConfigError {
    try {
      parseConfig(yaml);
    } catch (e) {
      return e as ConfigError;
    }
    throw new Error("expected parseConfig to throw");
  }

  it("rejects two actions", () => {
    const e = err(`rules:\n  - match: x.com\n    open: X\n    inherit: true\n`);
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).toMatch(/at most one action/);
    expect(e.path).toBe("rules[0]");
  });

  it("rejects default without a multi-value open", () => {
    expect(err(`rules:\n  - match: x.com\n    open: X\n    default: X\n`).path).toBe("rules[0].default");
    expect(err(`rules:\n  - match: x.com\n    inherit: true\n    default: X\n`).path).toBe("rules[0].default");
  });

  it("rejects default not in the open list", () => {
    const e = err(`rules:\n  - match: x.com\n    open: [A, B]\n    default: C\n`);
    expect(e.message).toMatch(/not one of open/);
    expect(e.path).toBe("rules[0].default");
  });

  it("rejects an unknown key", () => {
    expect(err(`rules:\n  - match: x.com\n    opne: X\n`).message).toMatch(/unknown key "opne"/);
  });

  it("rejects a missing match", () => {
    expect(err(`rules:\n  - open: X\n`).message).toMatch(/missing "match"/);
  });

  it("rejects a match pattern / regex (bare hosts only)", () => {
    expect(err(`rules:\n  - match: "https://app.example.com/x/*"\n`).message).toMatch(/not a bare hostname|bare hostnames only/);
    expect(err(`rules:\n  - match:\n      regex: "^https://x/"\n`).message).toMatch(/regex/);
  });

  it("reports a YAML syntax error with a line number", () => {
    const e = err(`key: 'unterminated string\n`);
    expect(e).toBeInstanceOf(ConfigError);
    expect(typeof e.line).toBe("number");
  });

  it("rejects a non-mapping top level", () => {
    expect(err(`- just\n- a list\n`).message).toMatch(/must be a mapping/);
  });

  it("rejects rules that is not a list", () => {
    expect(err(`rules: nope\n`).path).toBe("rules");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/config/parse.test.ts`
Expected: FAIL — cannot resolve `../../src/config/parse`.

- [ ] **Step 4: Implement `src/config/parse.ts`**

```ts
// Parse + normalize + validate the user's YAML config into the resolver's Config.
// See docs/superpowers/specs/2026-07-10-config-parser-design.md.
import { parse, YAMLParseError } from "yaml";
import { hostMatcher } from "../matcher/matcher";
import type { Action, Config, Group, Matcher, Rule } from "../resolver/types";

export class ConfigError extends Error {
  readonly path?: string;
  readonly line?: number;
  readonly col?: number;
  constructor(message: string, opts: { path?: string; line?: number; col?: number } = {}) {
    super(message);
    this.name = "ConfigError";
    this.path = opts.path;
    this.line = opts.line;
    this.col = opts.col;
  }
}

const ACTION_KEYS = ["open", "inherit", "ignore", "redirector"] as const;
const ALLOWED_RULE_KEYS = new Set([
  "match", "open", "default", "inherit", "ignore", "redirector", "cookies", "scripts",
]);

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Turn one raw `match` entry into a Matcher. Only bare hostnames are supported;
// match patterns and the regex object form raise a clear ConfigError.
function toMatcher(entry: unknown, path: string): Matcher {
  if (isMapping(entry) && "regex" in entry) {
    throw new ConfigError(`${path}: regex matches are not supported yet (bare hostnames only for now)`, { path });
  }
  if (typeof entry !== "string") {
    throw new ConfigError(`${path}: match entry must be a bare hostname string`, { path });
  }
  try {
    return hostMatcher(entry);
  } catch {
    throw new ConfigError(`${path}: "${entry}" is not a bare hostname (match patterns/regex not supported yet)`, { path });
  }
}

function parseMatch(raw: unknown, path: string): { matchers: Matcher[]; firstHost: string } {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    throw new ConfigError(`${path}.match must not be empty`, { path: `${path}.match` });
  }
  const matchers = list.map((e, j) => toMatcher(e, `${path}.match[${j}]`));
  return { matchers, firstHost: list[0] as string }; // toMatcher proved list[0] is a string
}

function parseOpen(raw: Record<string, unknown>, path: string): Action {
  const open = raw.open;
  let containers: string[];
  if (typeof open === "string") {
    containers = [open];
  } else if (Array.isArray(open)) {
    if (open.length === 0) throw new ConfigError(`${path}.open must not be empty`, { path: `${path}.open` });
    containers = open.map((c, j) => {
      if (typeof c !== "string") {
        throw new ConfigError(`${path}.open[${j}] must be a container name (string)`, { path: `${path}.open[${j}]` });
      }
      return c;
    });
  } else {
    throw new ConfigError(`${path}.open must be a string or a list of strings`, { path: `${path}.open` });
  }
  return { kind: "open", containers };
}

function parseRule(raw: unknown, i: number): Rule {
  const path = `rules[${i}]`;
  if (!isMapping(raw)) throw new ConfigError(`${path} must be a mapping`, { path });

  for (const k of Object.keys(raw)) {
    if (!ALLOWED_RULE_KEYS.has(k)) throw new ConfigError(`unknown key "${k}" in ${path}`, { path });
  }
  if (!("match" in raw)) throw new ConfigError(`${path} is missing "match"`, { path });
  const { matchers, firstHost } = parseMatch(raw.match, path);

  const present = ACTION_KEYS.filter((k) => k in raw);
  if (present.length > 1) {
    throw new ConfigError(`${path} has more than one action (${present.join(", ")}); a rule has at most one action`, { path });
  }

  let action: Action;
  if (present.length === 0) {
    action = { kind: "open", containers: [firstHost] }; // auto-name after the first host
  } else {
    switch (present[0]) {
      case "inherit":
        if (raw.inherit !== true) throw new ConfigError(`${path}.inherit must be true`, { path });
        action = { kind: "inherit" };
        break;
      case "ignore":
        if (raw.ignore !== true) throw new ConfigError(`${path}.ignore must be true`, { path });
        action = { kind: "ignore" };
        break;
      case "redirector":
        if (raw.redirector !== true) throw new ConfigError(`${path}.redirector must be true`, { path });
        action = { kind: "redirector" };
        break;
      default: // "open"
        action = parseOpen(raw, path);
    }
  }

  if ("default" in raw) {
    if (action.kind !== "open" || action.containers.length < 2) {
      throw new ConfigError(`${path}.default is only valid with a multi-value "open"`, { path: `${path}.default` });
    }
    const def = raw.default;
    if (typeof def !== "string") {
      throw new ConfigError(`${path}.default must be a container name`, { path: `${path}.default` });
    }
    if (!action.containers.includes(def)) {
      throw new ConfigError(`${path}.default "${def}" is not one of open: [${action.containers.join(", ")}]`, { path: `${path}.default` });
    }
    action = { ...action, default: def };
  }

  return { match: matchers, action };
}

export function parseConfig(yamlText: string): Config {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (e) {
    if (e instanceof YAMLParseError) {
      const pos = e.linePos?.[0];
      throw new ConfigError(`YAML syntax error: ${e.message}`, { line: pos?.line, col: pos?.col });
    }
    throw e;
  }

  if (doc === null || doc === undefined) return { rules: [], groups: [] };
  if (!isMapping(doc)) throw new ConfigError("config must be a mapping with `rules` and/or `groups`");

  const rawRules = doc.rules ?? [];
  if (!Array.isArray(rawRules)) throw new ConfigError("`rules` must be a list", { path: "rules" });
  const rawGroups = doc.groups ?? [];
  if (!Array.isArray(rawGroups)) throw new ConfigError("`groups` must be a list", { path: "groups" });

  const rules = rawRules.map((r, i) => parseRule(r, i));
  const groups: Group[] = []; // group parsing added in Task 2
  return { rules, groups };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/config/parse.test.ts`
Expected: PASS. If the syntax-error test fails because `parse("key: 'unterminated string")` doesn't throw a `YAMLParseError` with `linePos`, log the actual error shape and adjust the extraction (the `yaml` lib throws `YAMLParseError` with a `.linePos: [{line, col}]`); do not weaken the assertion beyond confirming a line number is present.

- [ ] **Step 6: Verify types**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/config/parse.ts test/config/parse.test.ts
git commit -m "feat: config parser — rules, auto-naming, validation (YAML)"
```

---

## Task 2: Group parsing

Replace the `groups: []` stub with real group parsing.

**Files:**
- Modify: `src/config/parse.ts`
- Test: `test/config/parse.groups.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/config/parse.groups.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/config/parse";
import { hostMatcher as hm } from "../../src/matcher/matcher";

function err(yaml: string): ConfigError {
  try {
    parseConfig(yaml);
  } catch (e) {
    return e as ConfigError;
  }
  throw new Error("expected parseConfig to throw");
}

describe("parseConfig — groups", () => {
  it("parses a list of host groups", () => {
    const c = parseConfig(
      `groups:\n  - [google.com, google.de, youtube.com]\n  - [check24.de, check24.com]\n`,
    );
    expect(c.groups).toEqual([
      { match: [hm("google.com"), hm("google.de"), hm("youtube.com")] },
      { match: [hm("check24.de"), hm("check24.com")] },
    ]);
  });

  it("rejects a non-list group", () => {
    const e = err(`groups:\n  - google.com\n`);
    expect(e.path).toBe("groups[0]");
    expect(e.message).toMatch(/must be a list/);
  });

  it("rejects an empty group", () => {
    expect(err(`groups:\n  - []\n`).path).toBe("groups[0]");
  });

  it("rejects a pattern/regex entry in a group", () => {
    expect(err(`groups:\n  - ["https://x.com/*"]\n`).message).toMatch(/not a bare hostname|bare hostnames only/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config/parse.groups.test.ts`
Expected: FAIL — groups are stubbed to `[]`, so the parse test sees `[]` (mismatch) and the error tests don't throw.

- [ ] **Step 3: Add `parseGroup` and wire it in `src/config/parse.ts`**

Add this function (next to `parseRule`):
```ts
function parseGroup(raw: unknown, i: number): Group {
  const path = `groups[${i}]`;
  if (!Array.isArray(raw)) throw new ConfigError(`${path} must be a list of hostnames`, { path });
  if (raw.length === 0) throw new ConfigError(`${path} must not be empty`, { path });
  const match = raw.map((e, j) => toMatcher(e, `${path}[${j}]`));
  return { match };
}
```

Then replace the stub line in `parseConfig`:
```ts
  const groups: Group[] = []; // group parsing added in Task 2
```
with:
```ts
  const groups = rawGroups.map((g, i) => parseGroup(g, i));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config/parse.groups.test.ts test/config/parse.test.ts`
Expected: PASS (both files — the rule tests still green, groups now parsed).

- [ ] **Step 5: Verify types**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/config/parse.ts test/config/parse.groups.test.ts
git commit -m "feat: config parser — group parsing + validation"
```

---

## Task 3: Real-config integration test

Parse the actual `configurable-containers.config.yaml` end-to-end.

**Files:**
- Create: `test/config/parse.real.test.ts`

- [ ] **Step 1: Write the integration test**

`test/config/parse.real.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../../src/config/parse";
import type { Config, Action } from "../../src/resolver/types";

const yamlPath = fileURLToPath(new URL("../../configurable-containers.config.yaml", import.meta.url));
const config: Config = parseConfig(readFileSync(yamlPath, "utf8"));

// Matchers are opaque at the resolver boundary but are HostMatchers here.
const hostOf = (m: unknown) => (m as { host: string }).host;
const ruleForHost = (h: string) => config.rules.find((r) => r.match.some((m) => hostOf(m) === h));
const containers = (a: Action) => (a.kind === "open" ? a.containers : []);

describe("parseConfig — real configurable-containers.config.yaml", () => {
  it("parses without error and yields many rules + several groups", () => {
    expect(config.rules.length).toBeGreaterThan(30);
    expect(config.groups.length).toBeGreaterThanOrEqual(6);
  });

  it("auto-names a bare rule (adventofcode.com)", () => {
    expect(ruleForHost("adventofcode.com")?.action).toEqual({ kind: "open", containers: ["adventofcode.com"] });
  });

  it("maps the Haeger multi-host rule to open [Haeger]", () => {
    const r = ruleForHost("haegerconsulting.atlassian.net");
    expect(r).toBeTruthy();
    expect(r!.action).toEqual({ kind: "open", containers: ["Haeger"] });
    expect(r!.match.length).toBe(4);
  });

  it("keeps outlook.cloud.microsoft as a choice (open [Haeger, HSP], no default)", () => {
    expect(ruleForHost("outlook.cloud.microsoft")?.action).toEqual({ kind: "open", containers: ["Haeger", "HSP"] });
  });

  it("has inherit / ignore / redirector rules", () => {
    const kinds = config.rules.map((r) => r.action.kind);
    expect(kinds).toContain("inherit");
    expect(kinds).toContain("ignore");
    expect(kinds).toContain("redirector");
  });

  it("tolerates youtube overlays and maps it to open [Temporary]", () => {
    expect(containers(ruleForHost("youtube.com")!.action)).toContain("Temporary");
  });

  it("parses the google and microsoft groups", () => {
    const hasHost = (g: { match: unknown[] }, h: string) => g.match.some((m) => hostOf(m) === h);
    expect(config.groups.some((g) => hasHost(g, "google.com") && hasHost(g, "youtube.com"))).toBe(true);
    expect(config.groups.some((g) => hasHost(g, "microsoft.com"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run test/config/parse.real.test.ts`
Expected: PASS (7 tests). If a spot-check fails, DO NOT change `src/` to force it — first check whether the real YAML differs from the assumption (e.g. a host is spelled differently), and fix the *test expectation* to match the real file, or report a genuine parser bug. Report what you found.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm test`
Expected: all green — harness, resolver, matcher, PSL, integration, and the config-parser tests.
Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add test/config/parse.real.test.ts
git commit -m "test: config parser parses the real configurable-containers.config.yaml"
```

---

## Out of scope for this plan (deferred)

- Surfacing + validating **overlays** (`cookies`/`scripts`) — the adapter slice.
- **Match-patterns / regex** match grammars — later matcher slices (rejected here).
- Reading the config from disk/storage and the built-in **editor** — the parser takes a string.
- Upgrading **semantic** errors to line/col via the `yaml` document AST — a follow-up.
- The **extension entry** that assembles live `Deps` + `Config` and drives `resolve()` from Firefox events.
