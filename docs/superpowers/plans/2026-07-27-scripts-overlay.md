# Scripts Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a rule's configured `scripts` snippets at `document_start` so they run before the page's own scripts (F12) — the sibling of the `cookies` overlay. Full parity with the Temporary Containers `scripts` carry-over.

**Architecture:** A new **`script-injector`** registers every rule's scripts once at startup via `browser.contentScripts.register`; Firefox injects them at `runAt` for matching pages. Unlike the cookie-seeder (a per-request blocking listener), the injector is **registration-based** — no per-navigation listener, no interaction with the routing `Decision`. A pure `scriptRegistrations(config)` flattens rules → register-arg shape; a pure `matcherToPatterns(m)` converts a `HostMatcher` to WebExtension match patterns. Routing (`resolve`/`engine.ts`) is untouched — a reopened tab's canceled original never loads (so no script fires for it); the new tab re-navigates and the registered script fires in the final container.

**Tech Stack:** TypeScript (ESM), Vitest, esbuild, Selenium/geckodriver, `@types/firefox-webext-browser`.

**Design spec:** `docs/superpowers/specs/2026-07-27-scripts-overlay-design.md`

## Global Constraints

- **Do not change** `src/resolver/resolve.ts`, `src/engine/engine.ts`, `src/engine/registry.ts`, `src/engine/disposer.ts`, or `src/engine/cookie-seeder.ts`. This slice **adds** an overlay module + an injector sibling + a port seam + a matcher helper; it does not alter routing, disposal, or cookie seeding.
- **F11 (identity boundary):** `registerContentScript` is called with **no `cookieStoreId`**. The `RegisterContentScriptDetails` type deliberately omits `cookieStoreId` so the seam can't scope a script to a container. Scripts run in whatever tab loads the URL — the tab's own container after routing.
- **F12 (timing):** registration uses `runAt: "document_start"` (the default). Firefox injects registered `document_start` scripts before the page's own `<script>`s — the guarantee is structural, not a `await` ordering to get wrong.
- **Overlay ≠ action:** the overlay fires whenever its rule matches, for any action **except `ignore`** (the parser rejects `scripts` on an `ignore` rule; `scriptRegistrations` also skips `ignore` rules defensively).
- **No manifest change:** `browser.contentScripts.register` needs no permission beyond the host permissions (`<all_urls>`) already in `extensions/cc/manifest.json`.
- **MV2, not MV3:** use `browser.contentScripts.register` (Firefox MV2, supports inline `code`). The MV3 `userScripts` migration is a separate future slice; the `ScriptSpec`/`scriptRegistrations` pure core is delivery-agnostic.
- **Keep `fileParallelism: false`** (do not touch `vitest.config.ts`).
- **Use CLI long options** (`--run`, `--save-dev`).
- **Commit after every task.**

---

### Task 1: Config types + parser (`ScriptSpec`, `Rule.scripts`, validation)

**Files:**
- Modify: `src/resolver/types.ts`
- Modify: `src/config/parse.ts`
- Test: `test/config/parse.scripts.test.ts`
- Test: `test/config/parse.real.test.ts` (add one assertion)

**Interfaces:**
- Produces: `ScriptSpec` (in `src/resolver/types.ts`) and `Rule.scripts?: ScriptSpec[]`; `parseConfig` now populates `rule.scripts` from the YAML `scripts:` key.

> **Real-config note:** the author's `configurable-containers.config.yaml` (exercised by `parse.real.test.ts`) carries `scripts:` overlays on `youtube.com` and `kraftfuttermischwerk.de`. Until now the parser allow-listed but **dropped** them; after this task it parses them. Both conform to the validation below (`at: document_start`, string `run`), so `parse.real.test.ts` stays green — Step 6 asserts the youtube scripts now parse.

- [ ] **Step 1: Add `ScriptSpec` and `Rule.scripts` to the resolver types**

In `src/resolver/types.ts`, add the `ScriptSpec` interface just below `CookieSpec` and a `scripts?` field on `Rule`:

```ts
// Overlay: a snippet to inject at document_start (the browser.contentScripts.register
// js/runAt surface). resolve() ignores this; it is consumed by the script-injector, not
// the router. See the scripts-overlay design spec §5.
export interface ScriptSpec {
  run: string; // required: the JS source to inject (inline `code`)
  at?: "document_start" | "document_end" | "document_idle"; // default "document_start"
}
```

Then add the field to `Rule`:

```ts
export interface Rule {
  match: Matcher[]; // normalized to a list (single -> [single])
  action: Action;
  cookies?: CookieSpec[]; // overlay; resolve() ignores it (consumed by the cookie-seeder)
  scripts?: ScriptSpec[]; // overlay; resolve() ignores it (consumed by the script-injector)
}
```

- [ ] **Step 2: Write the failing parser test**

Create `test/config/parse.scripts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/config/parse";

const parse = (yaml: string) => parseConfig(yaml);

describe("parseConfig — scripts overlay", () => {
  it("parses a full script entry into rule.scripts", () => {
    const config = parse(`
rules:
  - match: youtube.com
    open: Temporary
    scripts:
      - at: document_start
        run: "localStorage.setItem('yt', '1');"
`);
    expect(config.rules[0].scripts).toEqual([
      { at: "document_start", run: "localStorage.setItem('yt', '1');" },
    ]);
  });

  it("defaults at to document_start when omitted", () => {
    const config = parse(`
rules:
  - match: x.com
    scripts:
      - { run: "document.title = 'hi';" }
`);
    expect(config.rules[0].scripts).toEqual([{ run: "document.title = 'hi';" }]);
  });

  it("parses multiple scripts on one rule", () => {
    const config = parse(`
rules:
  - match: x.com
    scripts:
      - { run: "a();" }
      - { at: document_end, run: "b();" }
`);
    expect(config.rules[0].scripts).toEqual([
      { run: "a();" },
      { at: "document_end", run: "b();" },
    ]);
  });

  it("leaves scripts undefined when the key is absent", () => {
    const config = parse(`rules:\n  - match: x.com\n`);
    expect(config.rules[0].scripts).toBeUndefined();
  });

  it("parses cookies and scripts on the same rule", () => {
    const config = parse(`
rules:
  - match: youtube.com
    open: Temporary
    cookies:
      - { name: wide, url: "https://www.youtube.com/", value: "1" }
    scripts:
      - { at: document_start, run: "localStorage.setItem('wide','1');" }
`);
    expect(config.rules[0].cookies).toEqual([
      { name: "wide", url: "https://www.youtube.com/", value: "1" },
    ]);
    expect(config.rules[0].scripts).toEqual([
      { at: "document_start", run: "localStorage.setItem('wide','1');" },
    ]);
  });

  it("rejects scripts on an ignore rule", () => {
    expect(() => parse(`
rules:
  - match: getpocket.com
    ignore: true
    scripts:
      - { run: "x();" }
`)).toThrow(/scripts.*not allowed.*ignore/i);
  });

  it("rejects a non-list scripts value", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    scripts: nope\n`)).toThrow(ConfigError);
  });

  it("rejects a script missing run", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    scripts:\n      - { at: document_start }\n`)).toThrow(/\.run is required/);
  });

  it("rejects an empty run", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    scripts:\n      - { run: "" }\n`)).toThrow(/\.run is required/);
  });

  it("rejects unknown keys and wrong-typed fields", () => {
    expect(() => parse(`rules:\n  - match: x.com\n    scripts:\n      - { run: "x();", bogus: 1 }\n`)).toThrow(/unknown key "bogus"/);
    expect(() => parse(`rules:\n  - match: x.com\n    scripts:\n      - { run: 123 }\n`)).toThrow(/\.run must be a string/);
    expect(() => parse(`rules:\n  - match: x.com\n    scripts:\n      - { run: "x();", at: whenever }\n`)).toThrow(/\.at must be one of/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest --run test/config/parse.scripts.test.ts`
Expected: FAIL — `scripts` is currently dropped, so `config.rules[0].scripts` is `undefined` and the validation errors don't fire.

- [ ] **Step 4: Implement script parsing in `src/config/parse.ts`**

Add `ScriptSpec` to the existing import:

```ts
import type { Action, Config, CookieSpec, Group, Matcher, Rule, ScriptSpec } from "../resolver/types";
```

Add this constant just below `SAME_SITE`:

```ts
const RUN_AT = new Set(["document_start", "document_end", "document_idle"]);
const ALLOWED_SCRIPT_KEYS = new Set(["at", "run"]);
```

Add these two functions just above `parseRule` (after `parseCookies`):

```ts
function parseScript(raw: unknown, path: string): ScriptSpec {
  if (!isMapping(raw)) throw new ConfigError(`${path} must be a mapping`, { path });
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_SCRIPT_KEYS.has(k)) throw new ConfigError(`unknown key "${k}" in ${path}`, { path });
  }

  const spec = {} as ScriptSpec;

  const run = raw.run;
  if (typeof run !== "string" || run === "") {
    throw new ConfigError(`${path}.run is required and must be a non-empty string`, { path: `${path}.run` });
  }
  spec.run = run;

  if ("at" in raw) {
    const v = raw.at;
    if (typeof v !== "string" || !RUN_AT.has(v)) {
      throw new ConfigError(`${path}.at must be one of document_start, document_end, document_idle`, { path: `${path}.at` });
    }
    spec.at = v as ScriptSpec["at"];
  }

  return spec;
}

function parseScripts(raw: unknown, path: string): ScriptSpec[] {
  if (!Array.isArray(raw)) throw new ConfigError(`${path}.scripts must be a list`, { path: `${path}.scripts` });
  return raw.map((entry, j) => parseScript(entry, `${path}.scripts[${j}]`));
}
```

In `parseRule`, change the final return block. Replace:

```ts
  if ("cookies" in raw) {
    if (action.kind === "ignore") {
      throw new ConfigError(`${path}.cookies is not allowed on an "ignore" rule`, { path: `${path}.cookies` });
    }
    return { match: matchers, action, cookies: parseCookies(raw.cookies, path) };
  }

  return { match: matchers, action };
```

with:

```ts
  const out: Rule = { match: matchers, action };

  if ("cookies" in raw) {
    if (action.kind === "ignore") {
      throw new ConfigError(`${path}.cookies is not allowed on an "ignore" rule`, { path: `${path}.cookies` });
    }
    out.cookies = parseCookies(raw.cookies, path);
  }

  if ("scripts" in raw) {
    if (action.kind === "ignore") {
      throw new ConfigError(`${path}.scripts is not allowed on an "ignore" rule`, { path: `${path}.scripts` });
    }
    out.scripts = parseScripts(raw.scripts, path);
  }

  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest --run test/config/parse.scripts.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Assert the real config's scripts now parse, then run the config + resolver suites**

In `test/config/parse.real.test.ts`, add this test inside the `describe(...)` block (it consumes the module-level `ruleForHost` helper already defined there):

```ts
  it("parses the youtube script overlays from the real config", () => {
    const scripts = ruleForHost("youtube.com")?.scripts;
    expect(scripts?.map((s) => s.at)).toEqual(["document_start"]);
    expect(scripts?.[0].run).toContain("yt-player-sticky-caption");
  });
```

Run: `npx vitest --run test/config test/resolver`
Expected: PASS. (The `Rule.scripts?` field is optional; existing tests that build/compare rules without it are unaffected. The real config's previously-dropped `scripts` now parse without error.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/resolver/types.ts src/config/parse.ts test/config/parse.scripts.test.ts test/config/parse.real.test.ts
git commit -m "feat(config): parse + validate the scripts overlay into Rule.scripts"
```

---

### Task 2: Pure overlay core (`matcherToPatterns`, `scriptsFor`, `scriptRegistrations`)

**Files:**
- Modify: `src/matcher/matcher.ts`
- Create: `src/overlays/scripts.ts`
- Test: `test/overlays/scripts.test.ts`

**Interfaces:**
- Produces (in `src/matcher/matcher.ts`): `matcherToPatterns(m: Matcher): string[]`.
- Produces (in `src/overlays/scripts.ts`):
  - `scriptsFor(url: string, config: Config, matchRule: Deps["matchRule"]): ScriptSpec[]`
  - `scriptRegistrations(config: Config): ScriptRegistration[]`
  - `ScriptRegistration = { matches: string[]; code: string; runAt: "document_start" | "document_end" | "document_idle" }`

- [ ] **Step 1: Write the failing test**

Create `test/overlays/scripts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matcherToPatterns } from "../../src/matcher/matcher";
import { scriptsFor, scriptRegistrations } from "../../src/overlays/scripts";
import { matchRule } from "../../src/matcher/matcher";
import { parseConfig } from "../../src/config/parse";

describe("matcherToPatterns", () => {
  it("converts a host matcher to the two covering patterns", () => {
    expect(matcherToPatterns({ kind: "host", host: "youtube.com" })).toEqual([
      "*://youtube.com/*",
      "*://*.youtube.com/*",
    ]);
  });

  it("patterns for a list of matchers are the union (no dedup required)", () => {
    const p = [
      ...matcherToPatterns({ kind: "host", host: "youtube.com" }),
      ...matcherToPatterns({ kind: "host", host: "youtube.de" }),
    ];
    expect(p).toEqual([
      "*://youtube.com/*", "*://*.youtube.com/*",
      "*://youtube.de/*", "*://*.youtube.de/*",
    ]);
  });
});

const config = parseConfig(`
rules:
  - match: specific.example
    open: A
    scripts:
      - { run: "specific();" }
  - match: pocket.example
    ignore: true
    scripts:
      - { run: "ignored();" }
  - match: example
    open: B
    scripts:
      - { at: document_end, run: "broad();" }
      - { run: "broad2();" }
`);

describe("scriptsFor", () => {
  it("returns the matched rule's scripts", () => {
    expect(scriptsFor("https://specific.example/", config, matchRule)).toEqual([
      { run: "specific();" },
    ]);
  });

  it("returns [] when no rule matches", () => {
    expect(scriptsFor("https://nomatch.test/", config, matchRule)).toEqual([]);
  });

  it("returns [] for a matched ignore rule", () => {
    expect(scriptsFor("https://pocket.example/", config, matchRule)).toEqual([]);
  });

  it("honours first-match precedence (specific above broad)", () => {
    expect(scriptsFor("https://specific.example/", config, matchRule)).toEqual([
      { run: "specific();" },
    ]);
  });

  it("returns [] for a rule that matches but carries no scripts", () => {
    const c = parseConfig(`rules:\n  - match: bare.example\n    open: C\n`);
    expect(scriptsFor("https://bare.example/", c, matchRule)).toEqual([]);
  });
});

describe("scriptRegistrations", () => {
  it("flattens every rule's scripts into register-arg shape, with match patterns", () => {
    const regs = scriptRegistrations(config);
    expect(regs).toEqual([
      {
        matches: ["*://specific.example/*", "*://*.specific.example/*"],
        code: "specific();",
        runAt: "document_start",
      },
      {
        matches: ["*://example/*", "*://*.example/*"],
        code: "broad();",
        runAt: "document_end",
      },
      {
        matches: ["*://example/*", "*://*.example/*"],
        code: "broad2();",
        runAt: "document_start",
      },
    ]);
  });

  it("skips rules without scripts and ignore rules", () => {
    const c = parseConfig(`
rules:
  - match: ignored.example
    ignore: true
    scripts:
      - { run: "x();" }
  - match: bare.example
    open: C
`);
    expect(scriptRegistrations(c)).toEqual([]);
  });

  it("returns [] for a config with no scripts", () => {
    const c = parseConfig(`rules:\n  - match: bare.example\n    open: C\n`);
    expect(scriptRegistrations(c)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --run test/overlays/scripts.test.ts`
Expected: FAIL — cannot resolve `matcherToPatterns` / `src/overlays/scripts`.

- [ ] **Step 3: Implement `matcherToPatterns` in `src/matcher/matcher.ts`**

Add at the bottom of the file (after `matchGroup`):

```ts
// The WebExtension match patterns that exactly cover a matcher's matches() semantics
// for http(s). A HostMatcher { host } matches the bare host OR any subdomain, so it
// expands to two patterns: *://<host>/* and *://*.<host>/*. Used by the script-injector
// to register content scripts against URL patterns (not per-URL).
export function matcherToPatterns(m: Matcher): string[] {
  switch (m.kind) {
    case "host":
      return [`*://${m.host}/*`, `*://*.${m.host}/*`];
  }
}
```

- [ ] **Step 4: Implement `src/overlays/scripts.ts`**

```ts
// Pure overlay core: which scripts apply to a URL, and the registration shape the
// injector hands to browser.contentScripts.register. No browser, no I/O. Consumed by
// the script-injector (src/engine/script-injector.ts).
import type { Config, ScriptSpec } from "../resolver/types";
import { matcherToPatterns, type Matcher } from "../matcher/matcher";

// The register-arg shape: one entry per (rule, script) pair. `matches` is the union of
// the rule's matchers' patterns; `code` is the inline JS; `runAt` defaults to
// document_start (ScriptSpec.at is optional).
export interface ScriptRegistration {
  matches: string[];
  code: string;
  runAt: "document_start" | "document_end" | "document_idle";
}

// The scripts to inject for `url`: the first matching rule's overlay, or [] when no
// rule matches or the matched rule is `ignore`. Routed through the SAME injected
// matchRule as the router, so overlay precedence can never drift from routing. (Used for
// pure testability; the injector itself registers patterns, not per-URL.)
export function scriptsFor(
  url: string,
  config: Config,
  matchRule: (url: string, rules: Config["rules"]) => Config["rules"][number] | null,
): ScriptSpec[] {
  const rule = matchRule(url, config.rules);
  if (!rule || rule.action.kind === "ignore") return [];
  return rule.scripts ?? [];
}

// Flatten every rule's scripts into the register-arg shape. Skips rules without scripts
// and `ignore` rules (the parser already rejects scripts-on-ignore; this is defensive
// for a hand-built Config). One registration per (rule, script) pair.
export function scriptRegistrations(config: Config): ScriptRegistration[] {
  const out: ScriptRegistration[] = [];
  for (const rule of config.rules) {
    if (rule.action.kind === "ignore") continue;
    if (!rule.scripts) continue;
    const matches = rule.match.flatMap((m: Matcher) => matcherToPatterns(m));
    for (const s of rule.scripts) {
      out.push({ matches, code: s.run, runAt: s.at ?? "document_start" });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest --run test/overlays/scripts.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/matcher/matcher.ts src/overlays/scripts.ts test/overlays/scripts.test.ts
git commit -m "feat(overlays): pure scriptsFor + matcherToPatterns + scriptRegistrations"
```

---

### Task 3: Port seam — `registerContentScript`

**Files:**
- Modify: `src/engine/port.ts`
- Modify: `src/engine/browser-port.ts`
- Modify: `test/engine/mock-port.ts`
- Test: `test/engine/browser-port.test.ts`

**Interfaces:**
- Produces types in `port.ts`: `RunAt`, `RegisterContentScriptDetails`, `RegisteredContentScript`.
- Produces (on `BrowserPort`): `registerContentScript(details: RegisterContentScriptDetails): Promise<RegisteredContentScript>`.
- Produces on the mock (`test/engine/mock-port.ts`): `registeredScripts: RegisterContentScriptDetails[]`.

- [ ] **Step 1: Add the seam types + method to `src/engine/port.ts`**

After the `Cookie` interface (and before `Tab`), add:

```ts
export type RunAt = "document_start" | "document_end" | "document_idle";

// A deliberately narrow slice of Firefox's RegisteredContentScriptOptions: only the
// fields the script-injector uses. cookieStoreId is OMITTED so the seam can't scope a
// script to a container (F11: scripts run wherever the URL loads).
export interface RegisterContentScriptDetails {
  matches: string[];
  js: { code: string }[];
  runAt: RunAt;
}

export interface RegisteredContentScript {
  unregister(): Promise<void>;
}
```

Add the method to the `BrowserPort` interface (after `getCookie`, at the end of the cookies block):

```ts
  // Scripts overlay — register a content script (inline code) at a runAt. The injector
  // registers once at startup; Firefox injects at runAt for matching pages (F12).
  registerContentScript(details: RegisterContentScriptDetails): Promise<RegisteredContentScript>;
```

- [ ] **Step 2: Write the failing adapter test (extend `test/engine/browser-port.test.ts`)**

Extend the `fakeBrowser()` factory: add a `contentScripts` block alongside `cookies`:

```ts
    contentScripts: {
      register: async (d: unknown) => {
        f.contentScripts._registered = d;
        return { unregister: async () => { f.contentScripts._unregistered = true; } };
      },
      _registered: null as unknown,
      _unregistered: false,
    },
```

Then add this test case inside the `describe("createBrowserPort", ...)` block:

```ts
  it("registerContentScript delegates to browser.contentScripts.register and returns a handle", async () => {
    const port = createBrowserPort();
    const handle = await port.registerContentScript({
      matches: ["*://work.example/*"],
      js: [{ code: "localStorage.setItem('cc_script','1');" }],
      runAt: "document_start",
    });
    expect(f.contentScripts._registered).toMatchObject({
      matches: ["*://work.example/*"],
      js: [{ code: "localStorage.setItem('cc_script','1');" }],
      runAt: "document_start",
    });
    expect(f.contentScripts._unregistered).toBe(false);
    await handle.unregister();
    expect(f.contentScripts._unregistered).toBe(true);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest --run test/engine/browser-port.test.ts`
Expected: FAIL — `port.registerContentScript` is not implemented.

- [ ] **Step 4: Implement the method in `src/engine/browser-port.ts`**

Add the `RegisterContentScriptDetails, RegisteredContentScript` imports to the existing `import type { … } from "./port"` block, then add the method to the object returned by `createBrowserPort()` (after `getCookie`):

```ts
    async registerContentScript(details) {
      const reg = await browser.contentScripts.register(details);
      return { unregister: () => reg.unregister() };
    },
```

> **Typecheck note:** `details` is our `RegisterContentScriptDetails` (a narrow slice); it is passed straight to `browser.contentScripts.register`, which accepts the wider `RegisteredContentScriptOptions`. The subset is structurally assignable — do **not** cast, and do **not** widen our type.

- [ ] **Step 5: Implement the method in the mock (`test/engine/mock-port.ts`)**

Add the type imports to the existing `import type { … } from "../../src/engine/port"` block:

```ts
  RegisterContentScriptDetails,
  RegisteredContentScript,
```

Add to the `MockPort` interface (after `calls`):

```ts
  registeredScripts: RegisterContentScriptDetails[];
```

Inside `createMockPort()`, add state near the other `let`s:

```ts
  const registeredScripts: RegisterContentScriptDetails[] = [];
```

add the method to the `port` object (after `getCookie`):

```ts
    async registerContentScript(details) {
      registeredScripts.push(details);
      return { unregister: async () => { /* no-op for tests */ } };
    },
```

and expose the list in the returned object (after `getStoredCookie`):

```ts
    registeredScripts,
```

- [ ] **Step 6: Run the adapter test + typecheck**

Run: `npx vitest --run test/engine/browser-port.test.ts`
Expected: PASS (original tests + 1 new).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the engine + disposer + cookie-seeder suites (no regression)**

Run: `npx vitest --run test/engine`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/engine/port.ts src/engine/browser-port.ts test/engine/mock-port.ts test/engine/browser-port.test.ts
git commit -m "feat(engine): port seam for contentScripts.register"
```

---

### Task 4: The script-injector (L3)

**Files:**
- Create: `src/engine/script-injector.ts`
- Test: `test/engine/script-injector.test.ts`

**Interfaces:**
- Consumes: `BrowserPort` from `src/engine/port`; `Config` from `src/resolver/types`; `scriptRegistrations` from `src/overlays/scripts`.
- Produces: `createScriptInjector(opts: ScriptInjectorOptions): Promise<void>` where `ScriptInjectorOptions = { port: BrowserPort; config: Config }`.

- [ ] **Step 1: Write the failing test**

Create `test/engine/script-injector.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import { createScriptInjector } from "../../src/engine/script-injector";
import { parseConfig } from "../../src/config/parse";

describe("script-injector", () => {
  it("registers each script with the right matches/code/runAt", async () => {
    const mock = createMockPort();
    const config = parseConfig(`
rules:
  - match: work.example
    open: Work
    scripts:
      - { at: document_start, run: "localStorage.setItem('cc_script','1');" }
  - match: two.example
    scripts:
      - { run: "first();" }
      - { at: document_end, run: "second();" }
`);
    await createScriptInjector({ port: mock.port, config });

    expect(mock.registeredScripts).toEqual([
      {
        matches: ["*://work.example/*", "*://*.work.example/*"],
        js: [{ code: "localStorage.setItem('cc_script','1');" }],
        runAt: "document_start",
      },
      {
        matches: ["*://two.example/*", "*://*.two.example/*"],
        js: [{ code: "first();" }],
        runAt: "document_start",
      },
      {
        matches: ["*://two.example/*", "*://*.two.example/*"],
        js: [{ code: "second();" }],
        runAt: "document_end",
      },
    ]);
  });

  it("defaults runAt to document_start when at is omitted", async () => {
    const mock = createMockPort();
    const config = parseConfig(`rules:\n  - match: x.example\n    scripts:\n      - { run: "x();" }\n`);
    await createScriptInjector({ port: mock.port, config });
    expect(mock.registeredScripts).toHaveLength(1);
    expect(mock.registeredScripts[0].runAt).toBe("document_start");
  });

  it("registers nothing when the config has no scripts", async () => {
    const mock = createMockPort();
    const config = parseConfig(`rules:\n  - match: bare.example\n    open: C\n`);
    await createScriptInjector({ port: mock.port, config });
    expect(mock.registeredScripts).toEqual([]);
  });

  it("skips an ignore rule's scripts (defensive — parser already rejects)", async () => {
    const mock = createMockPort();
    const config = parseConfig(`
rules:
  - match: ignored.example
    ignore: true
    scripts:
      - { run: "x();" }
`);
    // NOTE: parseConfig REJECTS scripts-on-ignore, so we hand-build the Config to test
    // the injector's defensive skip directly.
    const handBuilt = { ...config, rules: [{ match: config.rules[0].match, action: { kind: "ignore" as const }, scripts: [{ run: "x();" }] }] };
    await createScriptInjector({ port: mock.port, config: handBuilt });
    expect(mock.registeredScripts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --run test/engine/script-injector.test.ts`
Expected: FAIL — cannot resolve `../../src/engine/script-injector`.

- [ ] **Step 3: Implement `src/engine/script-injector.ts`**

```ts
import type { Config } from "../resolver/types";
import type { BrowserPort } from "./port";
import { scriptRegistrations } from "../overlays/scripts";

export interface ScriptInjectorOptions {
  port: BrowserPort;
  config: Config;
}

// A sibling of the engine, disposer, and cookie-seeder (wired at background.ts, not
// nested). Unlike the seeder (a per-request blocking listener), this is registration-
// based: at startup it registers each script via browser.contentScripts.register, and
// Firefox injects it at runAt for matching pages (F12 — document_start runs before the
// page's own scripts). No cookieStoreId is set (F11 — the script runs wherever the URL
// loads, i.e. in the tab's own container after routing).
export async function createScriptInjector(opts: ScriptInjectorOptions): Promise<void> {
  const { port, config } = opts;
  for (const reg of scriptRegistrations(config)) {
    await port.registerContentScript({
      matches: reg.matches,
      js: [{ code: reg.code }],
      runAt: reg.runAt,
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --run test/engine/script-injector.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/script-injector.ts test/engine/script-injector.test.ts
git commit -m "feat(engine): script-injector — registration-based document_start injection"
```

---

### Task 5: Wire the injector into the extension + bundled script rule

**Files:**
- Modify: `src/extension/background.ts`
- Modify: `src/extension/config.ts`
- Modify: `test/extension/config.test.ts`

**Interfaces:**
- Consumes: `createScriptInjector` from `src/engine/script-injector`.

- [ ] **Step 1: Add a script overlay to the bundled config**

In `src/extension/config.ts`, change `BUNDLED_CONFIG_YAML` from:

```ts
export const BUNDLED_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
    cookies:
      - { name: seed, url: "http://work.example/", value: "1" }
`;
```

to:

```ts
export const BUNDLED_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
    cookies:
      - { name: seed, url: "http://work.example/", value: "1" }
    scripts:
      - { at: document_start, run: "localStorage.setItem('cc_script', '1');" }
`;
```

- [ ] **Step 2: Extend the bundled-config test**

In `test/extension/config.test.ts`, add this test inside the `describe("bundled extension config", …)` block:

```ts
  it("carries the document_start script overlay on the work.example rule", () => {
    const config = parseConfig(BUNDLED_CONFIG_YAML);
    const rule = matchRule("https://work.example/", config.rules);
    expect(rule!.scripts).toEqual([
      { at: "document_start", run: "localStorage.setItem('cc_script', '1');" },
    ]);
  });
```

- [ ] **Step 3: Run the config test**

Run: `npx vitest --run test/extension/config.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire the injector in `src/extension/background.ts`**

Add the import:

```ts
import { createScriptInjector } from "../engine/script-injector";
```

and add the wiring after `createCookieSeeder(...)` (the injector is async but background
startup need not block on it; fire-and-forget is fine — Firefox holds the background
alive for the registered promises, and registration ordering relative to the first
navigation is not observable since the page can't load before the extension starts):

```ts
void createScriptInjector({ port, config });
```

- [ ] **Step 5: Typecheck (covers the background wiring)**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/extension/background.ts src/extension/config.ts test/extension/config.test.ts
git commit -m "feat(extension): wire script-injector + script overlay in bundled config"
```

---

### Task 6: Harness — server document_start probe + driver read helpers

**Files:**
- Modify: `harness/server.ts`
- Modify: `harness/firefox.ts`
- Test: `test/harness/server.test.ts` (add one case)

**Interfaces:**
- Produces (from `harness/firefox.ts`):
  - `readScriptAtStart(driver: WebDriver): Promise<string>` — the `localStorage.cc_script` value the page's own first script observed (`""` if CC's script didn't run before it).
  - `readLocalStorage(driver: WebDriver, key: string): Promise<string | null>` — generic localStorage read in the current tab.

- [ ] **Step 1: Add a document_start-observing inline script to the test server page**

In `harness/server.ts`, change the `html` so the page records — at its earliest opportunity — whether CC's `document_start` script already set `cc_script`. Replace the `html` assignment with:

```ts
    const html =
      "<!doctype html><html><head><title>probe-target</title>" +
      // This inline script runs at parse time, AFTER document_start content scripts.
      // If CC's script-injector already set localStorage.cc_script, it's visible here —
      // proving the injected script ran before the page's own scripts (F12 timing).
      "<script>document.documentElement.setAttribute('data-cc-script-at-start', localStorage.getItem('cc_script') || '');</script>" +
      `</head><body data-seen-cookie="${escapeAttr(cookie)}">ok</body></html>`;
```

- [ ] **Step 2: Add a server test for the document_start attribute**

In `test/harness/server.test.ts`, add this test inside the `describe("startServer", …)` block:

```ts
  it("records the cc_script localStorage value at the page's first script", async () => {
    const server = await startServer();
    try {
      const res = await fetch(server.url);
      const body = await res.text();
      expect(body).toContain("data-cc-script-at-start=\"\"");
    } finally {
      await server.close();
    }
  });
```

> The server has no `cc_script` localStorage, so the attribute is empty — that's the
> baseline. The L4 test (Task 7) asserts it's `"1"` when CC's script ran first.

- [ ] **Step 3: Run the server test**

Run: `npx vitest --run test/harness/server.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 4: Add the driver read helpers to `harness/firefox.ts`**

After `readCookieNamesDefault`, add:

```ts
// The localStorage.cc_script value the page's own first script observed — "1" iff CC's
// document_start script ran before the page's scripts (F12 timing proof).
export async function readScriptAtStart(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-script-at-start') || '';"
  )) as string;
}

// Generic localStorage read in the current tab (containers partition localStorage, so
// this reads the current tab's own container partition).
export async function readLocalStorage(driver: WebDriver, key: string): Promise<string | null> {
  return (await driver.executeScript(
    `return localStorage.getItem(${JSON.stringify(key)});`
  )) as string | null;
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Verify no plumbing/routing regression (needs Firefox + geckodriver)**

Run: `npx vitest --run test/e2e/plumbing.test.ts test/e2e/routing.test.ts`
Expected: PASS. The server change adds an inline `<script>` but keeps the title/attributes unchanged, so plumbing/routing assertions are unaffected. If geckodriver is unavailable locally, note it and defer to CI.

- [ ] **Step 7: Commit**

```bash
git add harness/server.ts harness/firefox.ts test/harness/server.test.ts
git commit -m "feat(harness): server document_start probe + localStorage read helpers"
```

---

### Task 7: L4 real-Firefox e2e (F12 timing)

**Files:**
- Test: `test/e2e/scripts.test.ts`

**Interfaces:**
- Consumes: `launch`, `awaitContainerTab`, `readScriptAtStart`, `readLocalStorage`, `readCookieNamesHere`, `type Session` from `harness/firefox`.

- [ ] **Step 1: Write the e2e test**

Create `test/e2e/scripts.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitContainerTab, readScriptAtStart, readLocalStorage, readCookieNamesHere, type Session,
} from "../../harness/firefox";

describe("scripts overlay (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  async function navFreshTab(url: string) {
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("injects the script at document_start, before the page's own scripts, in the routed container", async () => {
    const url = `http://work.example:${port}/`;
    await navFreshTab(url);

    // The routed Work tab (awaitContainerTab leaves the driver focused on it).
    const { name } = await awaitContainerTab(session.driver, url);
    expect(name).toBe("Work");

    // The cookie overlay (already shipped) still seeds alongside the new script overlay.
    expect(await readCookieNamesHere(session.driver)).toContain("seed");

    // F12 timing: the page's own first script saw cc_script ALREADY set — proving CC's
    // document_start content script ran before the page's <script>s.
    expect(await readScriptAtStart(session.driver)).toBe("1");

    // The script's effect is visible in localStorage (the Work container's partition).
    expect(await readLocalStorage(session.driver, "cc_script")).toBe("1");
  });
});
```

- [ ] **Step 2: Run the L4 test**

Run: `npx vitest --run test/e2e/scripts.test.ts`
Expected: PASS (1 test). It launches real Firefox with CC + probe. If it fails, debug against the spec §9 risks: confirm `network.dns.localDomains` resolves `work.example`; confirm `browser.contentScripts.register` is permissionless in this Firefox (if not, add `contentScripts`-adjacent handling — but no `contentScripts` permission exists in MV2); confirm the inline `<script>` runs after the registered `document_start` script. Do **not** weaken the assertions to make it pass.

- [ ] **Step 3: Run the full suite (regression)**

Run: `npx vitest --run`
Expected: all suites pass — unit (config, overlays, engine, matcher, psl, resolver), extension unit, and the e2e (plumbing, routing, disposal, cookies, scripts).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/scripts.test.ts
git commit -m "test(e2e): L4 scripts overlay — injected at document_start before page scripts"
```

---

## Self-review notes (author)

- **Spec coverage:** §1 module/scope → Tasks 2,4,5; §2 registration-based injector (sibling) → Tasks 4,5; §3 pure core (`matcherToPatterns`, `scriptsFor`, `scriptRegistrations`) → Task 2; §4 registration behavior (no per-request, F11 via no cookieStoreId, F12 via document_start) → Tasks 4,7; §5 `ScriptSpec` + `Rule.scripts` + parser validation incl. `scripts`-on-`ignore` + cookies-and-scripts-coexist → Task 1; §6 port seam (`registerContentScript` + detail/handle types, cookieStoreId omitted) → Task 3; §7 wiring (sibling, no deps) → Task 5; §8 testing (pure, config, L3 injector, L4 F12 timing) → Tasks 1,2,4,7; §9 risks (timing structural, F11 no cookieStoreId, registration-once, contentScripts availability, matcher extension) → Tasks 4,7 + Task 2's matcherToPatterns. No spec section is unmapped.
- **F12 at L4 — mechanism:** the page's own inline `<script>` (runs at parse time, after `document_start` content scripts) records whether `localStorage.cc_script` was already set. CC's registered `document_start` script sets it; the page's script therefore observes `"1"` — the concrete realization of "before the page's own scripts." This is the timing proof that mocks can't give (a mock would only assert `runAt: "document_start"` was passed, not that Firefox honors it).
- **Coexistence with the cookies overlay:** the bundled `work.example` rule carries BOTH overlays. The L4 test asserts the cookie still seeds (`readCookieNamesHere` contains `"seed"`) AND the script runs — proving the two sibling overlays don't interfere, mirroring the real `youtube.com` rule.
