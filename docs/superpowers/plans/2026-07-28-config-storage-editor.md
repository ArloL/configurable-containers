# Storage-Backed Config, Built-In Editor, and AMO Release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move CC's config out of the build-time `__CC_CONFIG_YAML__` constant into `browser.storage.local`, edit it in a built-in options page, and ship the result as a listed add-on on addons.mozilla.org via a CalVer-tagged GitHub Actions release.

**Architecture:** One new pure module (`src/config/load.ts`) owns the stored-vs-seed-vs-broken decision. `src/extension/config.ts` becomes a thin L4 adapter over `browser.storage.local` + `runtime.openOptionsPage()`. A new options page (`src/extension/options.ts`, a third esbuild entry) reads and writes that storage and calls `browser.runtime.reload()` to apply. **The `BrowserPort` seam does not change**, so there is no L3 mock churn. The build-time constant survives as the *first-run seed*, which is what keeps every existing e2e test passing untouched.

**Tech Stack:** TypeScript, esbuild (IIFE bundles), Vitest, Selenium/geckodriver against real Firefox, `web-ext` for AMO submission, GitHub Actions + [`ArloL/calver-tag-action`](https://github.com/ArloL/calver-tag-action).

**Design of record:** `docs/superpowers/specs/2026-07-28-config-storage-editor-design.md`. Read it before starting; this plan implements it and does not restate its reasoning.

## Global Constraints

- **Never put routing/matching logic in `src/engine/engine.ts`.** It is a thin adapter. Routing lives in `src/resolver/` and `src/matcher/`.
- **Do not add methods to `BrowserPort` (`src/engine/port.ts`) in this plan.** Storage, `runtime.reload()`, and `openOptionsPage()` are extension-layer concerns; `src/extension/*.ts` may touch `browser.*` directly, as `src/extension/choice.ts` already does.
- **Extension ID is `configurable-containers@k5d.de`** — exact string, used in the manifest and in the harness uuid pin.
- **Storage key is `configYaml`** in `browser.storage.local` — exact string.
- **CLI long options only** (`--source-dir`, not `-s`).
- **Keep `fileParallelism: false` in `vitest.config.ts`.** Several tests bundle CC to the same `extensions/cc/background.js`.
- **`npm test` runs unit *and* e2e** and launches real Firefox. `npm run typecheck` runs `tsc --noEmit` over `src/`, `test/`, and `harness/` — test code must type-clean.
- **Revert-verify every new regression test:** back the fix out, watch the test go red, restore it. Restore from an editor undo or a copy, **never** `git checkout` (it discards uncommitted work). This suite has shipped false greens twice.
- **Conventional commit prefixes**, one logical change per commit.
- esbuild constant-folds numbers (`300000` → `3e5`); assert against esbuild's form.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/config/load.ts` | Pure: `loadConfig(stored, seed)` → `{ config, error?, seeded }`. The whole decision. |
| `src/config/default.yaml` | The shipped first-run seed — a commented example that routes nothing. |
| `src/extension/options.ts` | Options page script: load, validate-on-input, save, reload. |
| `extensions/cc/options.html` | Options page markup + styles (tracked; `options.js` is a gitignored build output). |
| `scripts/package.ts` | Stage → version → zip. Used by `npm run package` and the release workflow. |
| `.github/workflows/release.yaml` | Manual-trigger release: test → tag → package → submit → GitHub Release. |
| `test/config/load.test.ts` | L1 for `loadConfig`. |
| `test/config/default.test.ts` | L1: the shipped seed parses and routes nothing. |
| `test/engine/registry.tmp-suffix.test.ts` | L1 for `highestTmpSuffix`. |
| `test/e2e/options.test.ts` | L4: four cases (§10 of the spec). |
| `test/extension/package.test.ts` | The packaging script stages, versions, and refuses a broken seed. |

**Modified**

| File | Change |
|---|---|
| `src/extension/config.ts` | `BUNDLED_CONFIG_YAML` → `SEED_CONFIG_YAML`; add storage read/write and `openConfigEditor()`. |
| `src/extension/background.ts` | Async wiring: read storage, `loadConfig`, seed on first run, open editor on error, seed `tmpSuffix`. |
| `src/engine/registry.ts` | Export pure `highestTmpSuffix(names)`. |
| `extensions/cc/manifest.json` | New ID, `storage` permission, `options_ui`. |
| `harness/build-extension.ts` | Third entry point (`options.ts`). |
| `harness/firefox.ts` | Pin CC's uuid; export `CC_EXTENSION_ID` / `ccExtensionUrl()`; `openExtensionPage`, `switchToUrl`. |
| `extensions/probe/background.js` | New `open` command in the relay. |
| `test/extension/config.test.ts` | Follow the constant rename. |
| `test/extension/build.test.ts` | Assert `options.js` is emitted. |
| `package.json` | `web-ext` devDependency; `package` and `submit` scripts. |
| `.gitignore` | `dist/`, `extensions/cc/options.js`. |
| `CLAUDE.md` | Record what a cold start gets wrong about storage/seed/options. |
| `README.md` | Install-from-AMO section. |

**Phase boundary:** Tasks 1–7 deliver storage-backed config plus the editor — working, shippable software on their own. Tasks 8–10 add the release pipeline. Stopping after Task 7 is a legitimate stopping point.

---

### Task 1: Pure `loadConfig`

**Files:**
- Create: `src/config/load.ts`
- Test: `test/config/load.test.ts`

**Interfaces:**
- Consumes: `parseConfig`, `ConfigError` from `src/config/parse.ts`; `Config` from `src/resolver/types.ts`.
- Produces: `loadConfig(stored: string | undefined, seed: string): LoadResult` where `LoadResult = { config: Config; error?: ConfigError; seeded: boolean }`.

**Context:** `parseConfig` throws `ConfigError` (with optional `path`, `line`, `col`). Note `parseConfig("")` does **not** throw — `yaml.parse("")` yields `null`, and `parseConfig` returns `{ rules: [], groups: [] }` for that. An empty config is legal and means "nothing matches"; do not add a special case for it.

- [ ] **Step 1: Write the failing test**

```ts
// test/config/load.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/load";
import { ConfigError } from "../../src/config/parse";

const SEED = `
rules:
  - match: seed.example
    open: Seed
`;

const STORED = `
rules:
  - match: stored.example
    open: Stored
`;

const BROKEN = `
rules:
  - match: 123
    open: Nope
`;

describe("loadConfig", () => {
  it("falls back to the seed when nothing is stored", () => {
    const r = loadConfig(undefined, SEED);
    expect(r.seeded).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.config.rules).toHaveLength(1);
    expect(r.config.rules[0].action).toEqual({ kind: "open", containers: ["Seed"] });
  });

  it("prefers the stored config over the seed", () => {
    const r = loadConfig(STORED, SEED);
    expect(r.seeded).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.config.rules[0].action).toEqual({ kind: "open", containers: ["Stored"] });
  });

  it("yields the empty config and the error when the stored config is broken", () => {
    const r = loadConfig(BROKEN, SEED);
    expect(r.seeded).toBe(false);
    expect(r.error).toBeInstanceOf(ConfigError);
    expect(r.config).toEqual({ rules: [], groups: [] });
  });

  // The crucial one: a broken stored config must NOT silently revert to the
  // seed, which would route against rules the user has not seen in months.
  it("does not fall back to the seed when the stored config is broken", () => {
    const r = loadConfig(BROKEN, SEED);
    expect(r.config.rules).toHaveLength(0);
  });

  it("yields the empty config when the SEED itself is broken on first run", () => {
    const r = loadConfig(undefined, BROKEN);
    expect(r.seeded).toBe(true);
    expect(r.error).toBeInstanceOf(ConfigError);
    expect(r.config).toEqual({ rules: [], groups: [] });
  });

  it("treats an empty stored config as valid and empty, not as absent", () => {
    const r = loadConfig("", SEED);
    expect(r.seeded).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.config).toEqual({ rules: [], groups: [] });
  });

  it("returns a fresh empty config object each time", () => {
    const a = loadConfig(BROKEN, SEED);
    const b = loadConfig(BROKEN, SEED);
    expect(a.config).not.toBe(b.config);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/config/load.test.ts`
Expected: FAIL — cannot resolve `../../src/config/load`.

- [ ] **Step 3: Write the implementation**

```ts
// src/config/load.ts
// Decides which YAML the extension actually runs: the user's stored config, the
// bundled first-run seed, or — when neither parses — nothing at all. Pure so the
// whole decision is testable without a browser. See the 2026-07-28 design spec §3.
import { parseConfig, ConfigError } from "./parse";
import type { Config } from "../resolver/types";

export interface LoadResult {
  config: Config;
  error?: ConfigError; // set iff parsing failed
  seeded: boolean; // true iff there was no stored config
}

export function loadConfig(stored: string | undefined, seed: string): LoadResult {
  const seeded = stored === undefined;
  const yamlText = seeded ? seed : stored;
  try {
    return { config: parseConfig(yamlText), seeded };
  } catch (e) {
    // Empty config => nothing matches => every site gets a fresh throwaway. Never
    // fall back to the seed: routing against months-stale rules is a silent wrong
    // answer, where temporary-only is a loud one.
    const error = e instanceof ConfigError ? e : new ConfigError(String(e));
    return { config: { rules: [], groups: [] }, error, seeded };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/config/load.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/config/load.ts test/config/load.test.ts
git commit --message "feat(config): pure loadConfig — stored beats seed, broken means empty"
```

---

### Task 2: Pure `highestTmpSuffix` (spec §9)

**Files:**
- Modify: `src/engine/registry.ts`
- Test: `test/engine/registry.tmp-suffix.test.ts`

**Interfaces:**
- Produces: `highestTmpSuffix(names: string[]): number` exported from `src/engine/registry.ts`.

**Context:** `src/extension/background.ts:22-24` starts its temp-container counter at `0`, so after any background restart new throwaways are named from `tmp1` again and collide by name with live ones. `runtime.reload()` on every config save makes that frequent. This helper lets the counter resume above whatever already exists. `TMP_PREFIX` is `"tmp"` and already exported from the same file.

- [ ] **Step 1: Write the failing test**

```ts
// test/engine/registry.tmp-suffix.test.ts
import { describe, it, expect } from "vitest";
import { highestTmpSuffix } from "../../src/engine/registry";

describe("highestTmpSuffix", () => {
  it("is 0 when no containers exist", () => {
    expect(highestTmpSuffix([])).toBe(0);
  });

  it("is 0 when no container is a throwaway", () => {
    expect(highestTmpSuffix(["Work", "Personal", "Banking"])).toBe(0);
  });

  it("finds the highest numeric suffix", () => {
    expect(highestTmpSuffix(["tmp1", "tmp7", "tmp3"])).toBe(7);
  });

  it("compares numerically, not lexicographically", () => {
    expect(highestTmpSuffix(["tmp9", "tmp10"])).toBe(10);
  });

  it("ignores tmp-prefixed names without a numeric suffix", () => {
    expect(highestTmpSuffix(["tmp", "tmpfoo", "tmp2"])).toBe(2);
  });

  it("ignores permanent containers that merely contain 'tmp'", () => {
    expect(highestTmpSuffix(["my-tmp-box", "Work"])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/engine/registry.tmp-suffix.test.ts`
Expected: FAIL — `highestTmpSuffix` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/engine/registry.ts`, directly below the `TMP_PREFIX` declaration:

```ts
// The largest N among existing `tmp<N>` container names, or 0 if there are none.
// The suffix counter is in-memory, so a background restart would otherwise reissue
// tmp1 and collide by name with a live throwaway. Names are the only durable record
// (see TMP_PREFIX above), so the counter is recovered from them at startup.
export function highestTmpSuffix(names: string[]): number {
  let max = 0;
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const rest = name.slice(TMP_PREFIX.length);
    if (!/^\d+$/.test(rest)) continue;
    max = Math.max(max, Number(rest));
  }
  return max;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/engine/registry.tmp-suffix.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/registry.ts test/engine/registry.tmp-suffix.test.ts
git commit --message "feat(registry): recover the tmp suffix counter from existing container names"
```

---

### Task 3: The options page

**Files:**
- Create: `extensions/cc/options.html`, `src/extension/options.ts`
- Modify: `extensions/cc/manifest.json`, `harness/build-extension.ts`, `src/extension/config.ts`, `test/extension/config.test.ts`, `test/extension/build.test.ts`, `.gitignore`

**Interfaces:**
- Consumes: `parseConfig`, `ConfigError` from `src/config/parse.ts`.
- Produces: from `src/extension/config.ts` — `SEED_CONFIG_YAML: string`, `CONFIG_STORAGE_KEY: "configYaml"`, `readStoredConfigYaml(): Promise<string | undefined>`, `writeStoredConfigYaml(yaml: string): Promise<void>`, `openConfigEditor(): Promise<void>`. DOM element ids `cc-config`, `cc-save`, `cc-error`, `cc-status`.

**Context:** Mirror `src/extension/choice.ts` — a plain page script bundled by esbuild to `extensions/cc/options.js` and loaded by a tracked HTML file. No framework, no editor library. The page is built **before** anything opens it, so `options_ui` never points at a missing file.

- [ ] **Step 1: Rewrite `src/extension/config.ts`**

```ts
// The extension's config plumbing: the build-time SEED, the storage it lives in
// after first run, and the editor page. This is an L4 adapter — the only place
// outside src/extension/ pages that touches browser.*. See the 2026-07-28 design
// spec §4/§5. The engine's BrowserPort seam deliberately knows nothing about it.

// Injected at bundle time by esbuild (harness/build-extension.ts). This is the
// FIRST-RUN SEED, not the live config: e2e injects the test config, the manual
// launcher injects the author's real one, and `npm run package` injects
// src/config/default.yaml.
declare const __CC_CONFIG_YAML__: string;
export const SEED_CONFIG_YAML: string = __CC_CONFIG_YAML__;

export const CONFIG_STORAGE_KEY = "configYaml";

// undefined means "never stored" (first run) — distinct from "" which is a valid,
// empty config. loadConfig() depends on that distinction.
export async function readStoredConfigYaml(): Promise<string | undefined> {
  const got = await browser.storage.local.get(CONFIG_STORAGE_KEY);
  const value = got[CONFIG_STORAGE_KEY];
  return typeof value === "string" ? value : undefined;
}

export async function writeStoredConfigYaml(yamlText: string): Promise<void> {
  await browser.storage.local.set({ [CONFIG_STORAGE_KEY]: yamlText });
}

export async function openConfigEditor(): Promise<void> {
  await browser.runtime.openOptionsPage();
}
```

- [ ] **Step 2: Follow the rename in the existing test**

In `test/extension/config.test.ts`, change the import and all five usages from `BUNDLED_CONFIG_YAML` to `SEED_CONFIG_YAML`:

```ts
import { SEED_CONFIG_YAML } from "../../src/extension/config";
```

and replace every `parseConfig(BUNDLED_CONFIG_YAML)` with `parseConfig(SEED_CONFIG_YAML)`.

- [ ] **Step 3: Write the options page markup**

```html
<!-- extensions/cc/options.html -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Configurable Containers — config</title>
  <style>
    body { font: 14px sans-serif; padding: 16px; max-width: 60em; }
    #cc-config { width: 100%; height: 70vh; font-family: monospace; font-size: 13px; }
    #cc-error { color: #a00; white-space: pre-wrap; min-height: 1.2em; }
    #cc-status { color: #555; }
    button { font-size: 14px; padding: 4px 12px; }
  </style>
</head>
<body>
  <p>Edit the routing config. Saving reloads the extension.</p>
  <textarea id="cc-config" spellcheck="false"></textarea>
  <p id="cc-error"></p>
  <p><button id="cc-save">Save</button> <span id="cc-status"></span></p>
  <script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 4: Write the options page script**

```ts
// src/extension/options.ts
// The config editor. Reads storage into a textarea, re-parses on every keystroke
// (parseConfig is pure and sub-millisecond at this size, so no debounce), and
// refuses to save anything that does not parse. Saving writes storage and reloads
// the extension so every sibling re-reads the config at startup — see the
// 2026-07-28 design spec §5.

import { parseConfig, ConfigError } from "../config/parse";
import { readStoredConfigYaml, writeStoredConfigYaml } from "./config";

const textarea = document.getElementById("cc-config") as HTMLTextAreaElement;
const saveButton = document.getElementById("cc-save") as HTMLButtonElement;
const errorEl = document.getElementById("cc-error")!;
const statusEl = document.getElementById("cc-status")!;

function describe(e: unknown): string {
  if (e instanceof ConfigError) {
    const where = e.line !== undefined ? ` (line ${e.line}${e.col !== undefined ? `, col ${e.col}` : ""})` : "";
    return e.message + where;
  }
  return String(e);
}

// Returns true iff the current text parses; drives the error region and Save.
function validate(): boolean {
  try {
    parseConfig(textarea.value);
    errorEl.textContent = "";
    saveButton.disabled = false;
    return true;
  } catch (e) {
    errorEl.textContent = describe(e);
    saveButton.disabled = true;
    return false;
  }
}

textarea.addEventListener("input", () => {
  statusEl.textContent = "";
  validate();
});

saveButton.addEventListener("click", () => {
  if (!validate()) return;
  void (async () => {
    await writeStoredConfigYaml(textarea.value);
    statusEl.textContent = "Saved — reloading";
    // runtime.reload() tears down every extension page, including this one. The
    // delay lets the status paint first so the teardown reads as a consequence of
    // the click rather than a crash.
    setTimeout(() => browser.runtime.reload(), 100);
  })();
});

void (async () => {
  textarea.value = (await readStoredConfigYaml()) ?? "";
  // Validate on load too: the stored text may already be broken (spec §6), and the
  // page must show that without waiting for a keystroke.
  validate();
})();
```

- [ ] **Step 5: Add the third esbuild entry**

In `harness/build-extension.ts`, below `CHOICE_ENTRY`:

```ts
const OPTIONS_ENTRY = path.resolve(HERE, "../src/extension/options.ts");
```

and change the `entryPoints` array to:

```ts
    entryPoints: [ENTRY, CHOICE_ENTRY, OPTIONS_ENTRY],
```

- [ ] **Step 6: Update the manifest**

Edit `extensions/cc/manifest.json` — change the `gecko.id`, add `"storage"` to `permissions`, and add `options_ui` after `background`:

```json
  "browser_specific_settings": {
    "gecko": {
      "id": "configurable-containers@k5d.de"
    }
  },
  "permissions": [
    "webRequest",
    "webRequestBlocking",
    "cookies",
    "storage",
    "tabs",
    "contextualIdentities",
    "<all_urls>"
  ],
```

```json
  "options_ui": {
    "page": "options.html",
    "open_in_tab": true
  },
```

`open_in_tab` is deliberate: the about:addons embedded frame is too cramped for a config file, and a page CC opens itself on a bad config must be a visible tab.

- [ ] **Step 7: Gitignore the new build output**

Add to `.gitignore`, next to the existing `extensions/cc/choice.js` line:

```
extensions/cc/options.js
```

- [ ] **Step 8: Add the build assertion**

Append to `test/extension/build.test.ts`:

```ts
  it("emits the options page bundle alongside the background", async () => {
    await buildExtension();
    const optionsJs = fileURLToPath(new URL("../../extensions/cc/options.js", import.meta.url));
    expect(existsSync(optionsJs)).toBe(true);
    const code = readFileSync(optionsJs, "utf8");
    expect(code).toContain("parseConfig"); // validation is bundled into the page
    expect(code).toContain("configYaml"); // the storage key
  });
```

Add `import { fileURLToPath } from "node:url";` to that file's imports. **The project is ESM (`"type": "module"`); `__dirname` does not exist.** `test/config/parse.real.test.ts:7` is the pattern to follow.

- [ ] **Step 9: Run the affected tests**

Run: `npx vitest run test/extension/`
Expected: PASS — build, config, and picker-protocol suites all green.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add extensions/cc/options.html extensions/cc/manifest.json src/extension/options.ts \
        src/extension/config.ts harness/build-extension.ts .gitignore \
        test/extension/config.test.ts test/extension/build.test.ts
git commit --message "feat(extension): config editor page backed by storage.local"
```

---

### Task 4: Wire the background to storage

**Files:**
- Modify: `src/extension/background.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `highestTmpSuffix` (Task 2), `SEED_CONFIG_YAML` / `readStoredConfigYaml` / `writeStoredConfigYaml` / `openConfigEditor` (Task 3).

**Context:** Sibling wiring moves inside an async IIFE because the storage read is async. `createScriptInjector` is already awaited, so this is not a new shape. Keep every sibling a sibling — none of them nests inside `createEngine`. `createEngine` must keep returning `{ reopen }`, and the picker must keep receiving it.

- [ ] **Step 1: Replace the body of `src/extension/background.ts`**

Keep the existing import block and add four imports; replace everything from `const port = createBrowserPort();` onward.

```ts
import { loadConfig } from "../config/load";
import { highestTmpSuffix } from "../engine/registry";
import {
  SEED_CONFIG_YAML,
  readStoredConfigYaml,
  writeStoredConfigYaml,
  openConfigEditor,
} from "./config";
```

```ts
const port = createBrowserPort();

// Injected at bundle time by esbuild (harness/build-extension.ts).
declare const __CC_GRACE_MS__: number;
declare const __CC_REDIRECTOR_DELAY_MS__: number;

// Wiring is async because the config now comes from storage. A navigation during
// this window goes unrouted; it is one storage read at background-page load, so the
// window is milliseconds. See the 2026-07-28 design spec §2.
void (async () => {
  const stored = await readStoredConfigYaml();
  const { config, error, seeded } = loadConfig(stored, SEED_CONFIG_YAML);

  // First run: the seed becomes the user's config, and storage is truth from here
  // on — a later version shipping a different seed never overrides an edited config.
  if (seeded && !error) await writeStoredConfigYaml(SEED_CONFIG_YAML);

  if (error) {
    // Empty config: nothing matches, so every site opens in a fresh throwaway. The
    // failure cannot route a site into the WRONG permanent container, and the editor
    // opens with the broken text and the parse error already showing.
    console.error("[cc] config failed to parse — routing everything to a temporary container", error);
    await openConfigEditor();
  }

  // Resume the throwaway counter above any tmp<N> that already exists, so a reload
  // (every config save triggers one) does not reissue a live container's name.
  let n = highestTmpSuffix((await port.queryIdentities()).map((c) => c.name));
  const tmpSuffix = () => String(++n);

  // `picker` is referenced inside onChoice (which fires only at navigation time, after
  // construction), so the forward-reference is safe. Hoisted with `let` to satisfy the
  // linter and make the dependency direction explicit.
  let picker: ReturnType<typeof createPicker>;
  const engine = createEngine({
    port,
    config,
    deps: { matchRule, matchGroup, sameSite },
    tmpSuffix,
    onChoice: (options, nav) => {
      void picker.showChoice(nav.tabId, nav.url, options);
    },
  });
  picker = createPicker({ port, config, deps: { matchRule }, reopen: engine.reopen });

  createAutoTemp({ port, tmpSuffix });

  createDisposer({ port, clock: realClock, graceMs: __CC_GRACE_MS__ });

  createCookieSeeder({ port, config, deps: { matchRule } });

  void createScriptInjector({ port, config });

  createRedirectorCloser({
    port,
    clock: realClock,
    config,
    deps: { matchRule },
    delayMs: __CC_REDIRECTOR_DELAY_MS__,
  });
})();
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS throughout. This is the regression gate that matters: every existing e2e boots a fresh Firefox profile, so storage is empty, `loadConfig` takes the seed path, and the injected test config routes exactly as before. If the seed path is broken, the whole e2e suite goes red here.

- [ ] **Step 4: Commit**

```bash
git add src/extension/background.ts
git commit --message "feat(extension): load config from storage, seeding it on first run"
```

---

### Task 5: Harness — reach the options page

**Files:**
- Modify: `harness/firefox.ts`, `extensions/probe/background.js`

**Interfaces:**
- Produces: `CC_EXTENSION_ID`, `CC_EXTENSION_UUID`, `ccExtensionUrl(path: string): string`, `openExtensionPage(driver, url)`, `switchToUrl(driver, urlPrefix, timeoutMs?)` from `harness/firefox.ts`; probe command `open`.

**Context, verified empirically — do not re-litigate:**
1. **WebDriver cannot navigate to a `moz-extension://` URL.** `driver.get` fails with *"Navigation to moz-extension://… is not allowed in this context"* — Marionette's non-web-scheme restriction, same as `about:newtab`. Pinning the uuid does not change this.
2. **The probe can open CC's pages, and `extensions.webextensions.uuids` pins the origin.** Tested together: with the pref set, the probe's `tabs.create({ url: "moz-extension://<pinned>/choice.html" })` loaded the page. `web_accessible_resources` is **not** needed — Firefox gates those on web content, not on other extensions — and must not be added, since it would expose the config editor to every website.

- [ ] **Step 1: Add the `open` command to the probe**

In `extensions/probe/background.js`, inside `browser.runtime.onMessage.addListener`, add before the `newTab` branch:

```js
  if (msg && msg.cmd === "open") {
    const t = await browser.tabs.create({ url: msg.url });
    return { id: t.id, url: t.url };
  }
```

and extend the comment block above the listener:

```js
//   open    — open an arbitrary URL in a new tab, including another extension's
//             moz-extension:// page. WebDriver cannot navigate to that scheme at
//             all, and Firefox lets one extension open another's pages without
//             web_accessible_resources (that gate is for web content).
```

- [ ] **Step 2: Pin CC's uuid in `launch`**

In `harness/firefox.ts`, add near the top-level constants:

```ts
// CC's extension id (must match extensions/cc/manifest.json) and a FIXED uuid for
// its moz-extension:// origin, pinned via the extensions.webextensions.uuids pref in
// launch(). Without the pin the origin is random per profile and a test could not
// address an extension page at all.
export const CC_EXTENSION_ID = "configurable-containers@k5d.de";
export const CC_EXTENSION_UUID = "5c5b6d4e-9f3a-4a21-8b7c-1d2e3f4a5b6c";

export function ccExtensionUrl(pagePath: string): string {
  return `moz-extension://${CC_EXTENSION_UUID}/${pagePath}`;
}
```

and inside `launch`, next to the other `setPreference` calls:

```ts
  options.setPreference(
    "extensions.webextensions.uuids",
    JSON.stringify({ [CC_EXTENSION_ID]: CC_EXTENSION_UUID }),
  );
```

- [ ] **Step 3: Add the driver-side helpers**

Append to `harness/firefox.ts`:

```ts
// Open a URL in a new tab via the probe. The ONLY way a test can reach a
// moz-extension:// page: WebDriver refuses that scheme ("Navigation to
// moz-extension://… is not allowed in this context"), while an extension may open
// another extension's pages. The driver must already be on a probe-reported http(s)
// page for the command relay to exist.
export function openExtensionPage(
  driver: WebDriver,
  url: string,
): Promise<{ id: number; url: string }> {
  return probeCommand(driver, "open", { url });
}

// Switch the driver to the first window handle whose URL starts with `urlPrefix`.
// Opening a tab does not move the driver, and an extension page is not addressable
// by navigation, so this is how a test starts operating one.
export async function switchToUrl(
  driver: WebDriver,
  urlPrefix: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    seen = [];
    for (const handle of await driver.getAllWindowHandles()) {
      try {
        await driver.switchTo().window(handle);
        const current = await driver.getCurrentUrl();
        seen.push(current);
        if (current.startsWith(urlPrefix)) return;
      } catch {
        // Tab vanished mid-poll (CC reopens tear tabs down) — keep looking.
      }
    }
    await driver.sleep(200);
  }
  throw new Error(`no window at ${urlPrefix}; saw ${JSON.stringify(seen)}`);
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 5: Verify the existing e2e still passes with the new id and pref**

Run: `npx vitest run test/e2e/routing.test.ts`
Expected: PASS. The extension ID change and the uuid pref must not disturb normal routing.

- [ ] **Step 6: Commit**

```bash
git add harness/firefox.ts extensions/probe/background.js
git commit --message "test(harness): pin CC's extension origin and let the probe open its pages"
```

---

### Task 6: L4 — the options page in real Firefox

**Files:**
- Create: `test/e2e/options.test.ts`

**Interfaces:**
- Consumes: `launch`, `awaitContainerTab`, `openExtensionPage`, `switchToUrl`, `ccExtensionUrl`, `listTabs` from `harness/firefox.ts`.

**Context:** `nomatch.example` is already in `DEFAULT_LOCAL_DOMAINS` and matches no rule in the test config, which makes it the ideal target for "a rule the editor just added." Setting `textarea.value` from a script does **not** fire `input`, so the test must dispatch the event itself or validation never runs.

- [ ] **Step 1: Write the test**

```ts
// test/e2e/options.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import {
  launch, awaitContainerTab, openExtensionPage, switchToUrl, ccExtensionUrl, listTabs,
  readContainerName, type Session,
} from "../../harness/firefox";

const OPTIONS_URL = ccExtensionUrl("options.html");

// A config the editor types in: routes nomatch.example (which matches nothing in the
// bundled test config) into a permanent container named Editor.
const EDITED_CONFIG = `
rules:
  - match: nomatch.example
    open: Editor
`;

const BROKEN_SEED = `
rules:
  - match: 123
    open: Nope
`;

describe("options page (real Firefox, CC + probe)", () => {
  describe("with a valid seed", () => {
    let session: Session;
    let port: string;

    beforeAll(async () => {
      session = await launch({ extensions: ["probe", "cc"] });
      port = new URL(session.serverUrl).port;
    });

    afterAll(async () => {
      await session?.close();
    });

    // Park on a probe-reported page so the cc-probe-cmd relay exists. work.example is
    // matched, so CC leaves it in Work rather than churning; the cache-buster forces a
    // fresh probe report.
    async function parkOnProbePage(tag: string) {
      const url = `http://work.example:${port}/?cb=${tag}-${Date.now()}`;
      try {
        await session.driver.get(url);
      } catch {
        // First visit reopens the tab into Work, tearing this one down — expected.
      }
      await awaitContainerTab(session.driver, url);
    }

    async function openEditor(tag: string) {
      await parkOnProbePage(tag);
      await openExtensionPage(session.driver, OPTIONS_URL);
      await switchToUrl(session.driver, OPTIONS_URL);
    }

    // Set the textarea and fire `input` — assigning .value alone does not, so
    // validation would never run.
    async function typeConfig(text: string) {
      await session.driver.executeScript(
        "const t = document.getElementById('cc-config');" +
        `t.value = ${JSON.stringify(text)};` +
        "t.dispatchEvent(new Event('input'));"
      );
    }

    it("shows the seeded config on first run", async () => {
      await openEditor("seed");
      const value = await session.driver.findElement(By.id("cc-config")).getAttribute("value");
      // The bundled test config was written to storage at first run.
      expect(value).toContain("work.example");
      expect(value).toContain("redirect.example");
    });

    it("refuses to save a config that does not parse", async () => {
      await openEditor("invalid");
      await typeConfig("rules:\n  - match: 123\n    open: Nope\n");

      const error = await session.driver.findElement(By.id("cc-error")).getText();
      expect(error).not.toBe("");
      expect(await session.driver.findElement(By.id("cc-save")).isEnabled()).toBe(false);

      // …and recovers when the text becomes valid again.
      await typeConfig(EDITED_CONFIG);
      expect(await session.driver.findElement(By.id("cc-error")).getText()).toBe("");
      expect(await session.driver.findElement(By.id("cc-save")).isEnabled()).toBe(true);
    });

    it("routes by the saved config after the reload", async () => {
      await openEditor("save");
      await typeConfig(EDITED_CONFIG);
      await session.driver.findElement(By.id("cc-save")).click();

      // runtime.reload() tears down every extension page, this tab included. Get off
      // it before touching the driver again.
      await session.driver.sleep(2000);
      const handles = await session.driver.getAllWindowHandles();
      await session.driver.switchTo().window(handles[0]);

      // nomatch.example matched no rule before this edit; it must now land in Editor.
      const url = `http://nomatch.example:${port}/?cb=edited-${Date.now()}`;
      try {
        await session.driver.get(url);
      } catch {
        // CC reopens the tab into Editor, tearing this one down — expected.
      }
      await awaitContainerTab(session.driver, url);
      expect(await readContainerName(session.driver)).toBe("Editor");
    });
  });

  describe("with a seed that does not parse", () => {
    let session: Session;
    let port: string;

    beforeAll(async () => {
      session = await launch({ extensions: ["probe", "cc"], configYaml: BROKEN_SEED });
      port = new URL(session.serverUrl).port;
    });

    afterAll(async () => {
      await session?.close();
    });

    it("opens the editor itself and routes everything to a temporary container", async () => {
      // Every http URL is unmatched under the empty config, so this tab is reopened
      // into a throwaway; that is also what parks us on a probe-reported page.
      const url = `http://work.example:${port}/?cb=broken-${Date.now()}`;
      try {
        await session.driver.get(url);
      } catch {
        // Reopened into a tmp container — expected.
      }
      await awaitContainerTab(session.driver, url);
      expect(await readContainerName(session.driver)).toMatch(/^tmp/);

      // CC called openOptionsPage() at startup, so the editor is already open.
      const tabs = await listTabs(session.driver);
      expect(tabs.some((t) => t.url === OPTIONS_URL)).toBe(true);

      // And it shows the parse error rather than a blank page.
      await switchToUrl(session.driver, OPTIONS_URL);
      expect(await session.driver.findElement(By.id("cc-error")).getText()).not.toBe("");
    });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/e2e/options.test.ts`
Expected: PASS (4 tests). Firefox windows will open.

- [ ] **Step 3: Revert-verify — the editor case**

Temporarily change `saveButton.disabled = true` to `saveButton.disabled = false` in `src/extension/options.ts` (keep a copy of the original line). Run the suite; "refuses to save a config that does not parse" must FAIL. Restore the line **from your copy or editor undo — not `git checkout`**, which would discard the whole task's uncommitted work.

- [ ] **Step 4: Revert-verify — the failure path**

Temporarily remove the `await openConfigEditor();` call in `src/extension/background.ts`. Run the suite; "opens the editor itself and routes everything to a temporary container" must FAIL on the `listTabs` assertion. Restore it the same way.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS throughout.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/options.test.ts
git commit --message "test(e2e): prove the editor writes storage and CC routes by it"
```

---

### Task 7: Document the new reality

**Files:**
- Modify: `CLAUDE.md`

**Context:** CLAUDE.md records only what the code and the other docs do *not* say — the things a cold start gets wrong. Three findings from this slice qualify.

- [ ] **Step 1: Add a config-storage section**

Add to `CLAUDE.md`, after the "Firefox extension constraints" section:

```markdown
## Config lives in storage, not in the bundle

- **`__CC_CONFIG_YAML__` is the first-run SEED, not the live config.** `src/extension/config.ts`
  exports it as `SEED_CONFIG_YAML`; the live config is `browser.storage.local.configYaml`,
  written on first run and truth from then on. A later version shipping a different seed
  **never** overrides an edited config — that is the point, not a bug. Three builds inject
  three different seeds: e2e gets `TEST_CONFIG_YAML` (`harness/build-extension.ts`),
  `npm run manual` gets the author's `configurable-containers.config.yaml`, and
  `npm run package` gets the shipped `src/config/default.yaml`.
- **A broken stored config must never fall back to the seed.** `loadConfig` (`src/config/load.ts`)
  returns the *empty* config plus the error, so everything opens in a throwaway and the
  editor is opened. Falling back would route against months-stale rules — a silent wrong
  answer where temporary-only is a loud one. Note `parseConfig("")` does not throw: an
  empty config is legal and means "nothing matches".
- **Saving reloads the extension** (`browser.runtime.reload()`), which is why the
  `tmpSuffix` counter is recovered from existing container names via `highestTmpSuffix`
  (`src/engine/registry.ts`) instead of restarting at 0 — otherwise every save reissues
  `tmp1` alongside a live `tmp1`.
- **Background wiring is async** because of the storage read. A navigation in that window
  goes unrouted; it is one read at background-page load. Don't add further awaits before
  the siblings are wired.
```

- [ ] **Step 2: Add the extension-page addressing findings to the testing section**

Add to CLAUDE.md's "Testing reality" section:

```markdown
- **WebDriver cannot navigate to a `moz-extension://` URL** — `driver.get` fails with
  *"Navigation to moz-extension://… is not allowed in this context"*, Marionette's
  non-web-scheme restriction, the same one that blocks `about:newtab`. Pinning the uuid
  does not help. The driver can only *operate* an extension page something else opened.
- **The probe opens extension pages; `extensions.webextensions.uuids` pins the origin.**
  `launch()` sets that pref so CC's origin is the constant `ccExtensionUrl()` builds, and
  the probe's `open` command does the `tabs.create`. Firefox gates `web_accessible_resources`
  on *web content*, not on other extensions, so CC must **not** list `options.html` there —
  doing so would expose the config editor to every website, and it buys nothing for tests.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit --message "docs: record the storage/seed split and extension-page addressing"
```

---

### Task 8: The shipped default config

**Files:**
- Create: `src/config/default.yaml`, `test/config/default.test.ts`

**Context:** This becomes every installer's default and, since the only UI is a text editor, the primary documentation a new user meets. It must route **nothing** — a public default that silently containerized real domains would be hostile. `CONFIG.md` is the reference for the syntax used here.

- [ ] **Step 1: Write the failing test**

```ts
// test/config/default.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../../src/config/parse";
import { matchRule } from "../../src/matcher/matcher";

// ESM: no __dirname. Same pattern as test/config/parse.real.test.ts:7.
const DEFAULT_YAML = readFileSync(
  fileURLToPath(new URL("../../src/config/default.yaml", import.meta.url)),
  "utf8",
);

describe("the shipped default config", () => {
  it("parses", () => {
    expect(() => parseConfig(DEFAULT_YAML)).not.toThrow();
  });

  // It ships to strangers: a default that silently routed real domains would be
  // hostile, so every rule must be commented out.
  it("routes nothing", () => {
    const config = parseConfig(DEFAULT_YAML);
    expect(config.rules).toEqual([]);
    expect(config.groups).toEqual([]);
    expect(matchRule("https://example.com/", config.rules)).toBeNull();
  });

  it("documents the syntax a new user needs", () => {
    expect(DEFAULT_YAML).toContain("rules:");
    expect(DEFAULT_YAML).toContain("match:");
    expect(DEFAULT_YAML).toContain("open:");
    expect(DEFAULT_YAML).toContain("groups:");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/config/default.test.ts`
Expected: FAIL — `src/config/default.yaml` does not exist.

- [ ] **Step 3: Write the default config**

```yaml
# src/config/default.yaml
# Configurable Containers — your routing config.
#
# Anything that matches no rule opens in a fresh temporary container, so an empty
# config is a working config: every site is isolated, nothing is remembered.
# Add rules for the sites you want a lasting, named container for.
#
# Full reference: https://github.com/ArloL/configurable-containers/blob/main/CONFIG.md
#
# Uncomment and edit. Saving reloads the extension.

# rules:
#   # The common case: one line. github.com opens in a container named "github.com".
#   - match: github.com
#
#   # A curated name instead of the domain.
#   - match: mail.google.com
#     open: Google
#
#   # Several domains sharing one container.
#   - match: [github.com, githubusercontent.com]
#     open: Code
#
#   # Offer a choice: a screen appears, and "Personal" is preselected. Use the
#   # reserved name "Temporary" for a throwaway.
#   - match: youtube.com
#     open: [Personal, Temporary]
#     default: Personal
#
#   # Leave a site entirely alone — CC never touches its tabs.
#   - match: addons.mozilla.org
#     ignore: true
#
#   # A link shim: don't isolate the hop, and close the tab if it strands there.
#   - match: t.co
#     redirector: true

# Isolation-continuity groups: sites in one group stay in the SAME throwaway as you
# move between them, while crossing to anything outside it spins up a clean one.
# groups:
#   - match: [example.com, example.org]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/config/default.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Verify the example syntax is real, not invented**

Uncomment the whole `rules:` and `groups:` blocks in a scratch copy of the file (not the tracked one) and run `parseConfig` on it via `npx tsx --eval` or a temporary test. Every construct must parse. Re-comment / discard the scratch copy. This catches an example that documents syntax the parser does not actually accept.

- [ ] **Step 6: Commit**

```bash
git add src/config/default.yaml test/config/default.test.ts
git commit --message "feat(config): shipped default config — commented example, routes nothing"
```

---

### Task 9: `npm run package`

**Files:**
- Create: `scripts/package.ts`, `test/extension/package.test.ts`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Produces: `packageExtension(opts: { version: string; seedPath?: string; outDir?: string }): Promise<{ xpiPath: string; stageDir: string }>` from `scripts/package.ts`.

**Context:** `manifest.json` keeps a placeholder version and is **never** edited in place — packaging stages `extensions/cc/` into `dist/cc/` and rewrites the version there, so a local run never dirties the tracked tree. The seed is parsed *before* building; that check belongs here and **not** in `buildExtension`, because `test/e2e/options.test.ts` depends on `buildExtension` accepting a deliberately invalid seed.

- [ ] **Step 1: Write the failing test**

```ts
// test/extension/package.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { packageExtension } from "../../scripts/package";

describe("packageExtension", () => {
  it("stages the extension with the given version and produces an xpi", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    try {
      const { xpiPath, stageDir } = await packageExtension({ version: "2607.0.101", outDir });
      expect(existsSync(xpiPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(stageDir, "manifest.json"), "utf8"));
      expect(manifest.version).toBe("2607.0.101");
      expect(manifest.browser_specific_settings.gecko.id).toBe("configurable-containers@k5d.de");
      expect(existsSync(path.join(stageDir, "background.js"))).toBe(true);
      expect(existsSync(path.join(stageDir, "options.js"))).toBe(true);
      expect(existsSync(path.join(stageDir, "options.html"))).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("leaves the tracked manifest untouched", async () => {
    const tracked = fileURLToPath(new URL("../../extensions/cc/manifest.json", import.meta.url));
    const before = readFileSync(tracked, "utf8");
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    try {
      await packageExtension({ version: "2607.0.102", outDir });
      expect(readFileSync(tracked, "utf8")).toBe(before);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("refuses to package a seed that does not parse", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    const badSeed = path.join(outDir, "bad.yaml");
    writeFileSync(badSeed, "rules:\n  - match: 123\n    open: Nope\n");
    try {
      await expect(
        packageExtension({ version: "2607.0.103", seedPath: badSeed, outDir }),
      ).rejects.toThrow(/bare hostname/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/extension/package.test.ts`
Expected: FAIL — cannot resolve `../../scripts/package`.

- [ ] **Step 3: Write the packaging script**

```ts
// scripts/package.ts
// Build a distributable XPI. Stages extensions/cc/ into dist/cc/ and stamps the
// version THERE, so manifest.json stays a placeholder in the tracked tree and a
// local run never dirties git. Run: npx tsx scripts/package.ts [version]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { buildExtension } from "../harness/build-extension";
import { parseConfig } from "../src/config/parse";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "../extensions/cc");
const DEFAULT_SEED = path.resolve(HERE, "../src/config/default.yaml");
const DEFAULT_OUT = path.resolve(HERE, "../dist");

export interface PackageOptions {
  version: string;
  seedPath?: string;
  outDir?: string;
}

export async function packageExtension(
  opts: PackageOptions,
): Promise<{ xpiPath: string; stageDir: string }> {
  const seedPath = opts.seedPath ?? DEFAULT_SEED;
  const outDir = opts.outDir ?? DEFAULT_OUT;
  const configYaml = readFileSync(seedPath, "utf8");

  // Fail before building: a seed that does not parse would make every fresh install
  // temporary-only, and the user would only see a swallowed console.error. This check
  // belongs HERE, not in buildExtension — the options e2e needs to build a broken seed
  // on purpose.
  parseConfig(configYaml);

  await buildExtension({ configYaml });

  const stageDir = path.join(outDir, "cc");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  cpSync(SRC_DIR, stageDir, { recursive: true });

  const manifestPath = path.join(stageDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = opts.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const xpiPath = path.join(outDir, `configurable-containers-${opts.version}.xpi`);
  rmSync(xpiPath, { force: true });
  execFileSync("zip", ["-r", "-FS", xpiPath, ".", "-x", ".*"], { cwd: stageDir });

  return { xpiPath, stageDir };
}

// CLI: `npx tsx scripts/package.ts 2607.0.101`. Defaults to 0.0.0 for local builds,
// which are never submitted — real versions come from the CalVer tag in CI.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const version = process.argv[2] ?? process.env.CC_VERSION ?? "0.0.0";
  packageExtension({ version })
    .then(({ xpiPath }) => console.log(xpiPath))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Add `scripts/` to the typechecked roots**

`tsconfig.json`'s `include` is `["harness", "test", "src"]`, so `scripts/package.ts` would go unchecked on its own. Change it to:

```json
  "include": ["harness", "scripts", "test", "src"]
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/extension/package.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Add the npm scripts and ignore `dist/`**

In `package.json`, add to `scripts`:

```json
    "package": "tsx scripts/package.ts",
    "submit": "web-ext sign --source-dir dist/cc --artifacts-dir dist --channel listed --api-key \"$WEB_EXT_API_KEY\" --api-secret \"$WEB_EXT_API_SECRET\""
```

Add `web-ext` to `devDependencies` (`npm install --save-dev web-ext`).

Add to `.gitignore`:

```
dist/
```

- [ ] **Step 7: Verify the CLI end to end**

Run: `npm run package -- 2607.0.101`
Expected: prints a path under `dist/`; `dist/configurable-containers-2607.0.101.xpi` exists; `git status` shows only `dist/` (ignored) — the tracked manifest is unchanged.

- [ ] **Step 8: Commit**

```bash
git add scripts/package.ts test/extension/package.test.ts package.json package-lock.json \
        tsconfig.json .gitignore
git commit --message "feat(build): package a versioned xpi from a staged copy"
```

---

### Task 10: Release workflow

**Files:**
- Create: `.github/workflows/release.yaml`
- Modify: `README.md`

**Context:** Follow `ci.yml`'s conventions — SHA-pinned actions with a version comment, least-privilege `permissions`. Two deliberate departures: this workflow needs `contents: write` and must **not** set `persist-credentials: false`, because `calver-tag-action` pushes a tag.

**Read before running this for real:** AMO's *first* submission for a new add-on generally has to be created through the Developer Hub UI, where the listing metadata (summary, description, category, license, data-collection declaration) is filled in. `web-ext sign --channel listed` automates *subsequent* versions. Expect the first release to need a manual step, and expect human review — `<all_urls>` + `webRequestBlocking` + `cookies` is the profile that draws it.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/release.yaml
name: Release

on:
  workflow_dispatch:

permissions: {}

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write # calver-tag-action pushes a tag; gh release creates a release
    steps:
      # NOT persist-credentials: false (unlike ci.yml) — the tag push needs the token.
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          fetch-depth: 0

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: 22
          cache: npm

      - uses: browser-actions/setup-firefox@0bc507ddf224827e3b1af68e014d5e42ab93e795 # v1.7.2
        id: firefox
        with:
          firefox-version: latest

      - run: npm ci

      - run: npm run typecheck

      # A release that has not passed e2e is not a release.
      - name: Run tests (headless Firefox via Selenium)
        env:
          FIREFOX_BIN: ${{ steps.firefox.outputs.firefox-path }}
        run: npm test

      - uses: ArloL/calver-tag-action@0e91bea86df7d9b445b6dbde498d30c273032ea0 # v2607.0.105
        id: version

      - name: Package the xpi at the tagged version
        run: npm run package -- "${{ steps.version.outputs.new_version }}"

      # AMO requires reviewable source whenever the shipped JS is bundled, and
      # background.js is an esbuild bundle. Built from the same checkout as the xpi
      # above, so the two cannot drift.
      - name: Build the source archive
        env:
          VERSION: ${{ steps.version.outputs.new_version }}
        run: |
          git archive --format=zip --output "dist/configurable-containers-src-${VERSION}.zip" HEAD

      - name: Submit to AMO (listed channel)
        env:
          WEB_EXT_API_KEY: ${{ secrets.WEB_EXT_API_KEY }}
          WEB_EXT_API_SECRET: ${{ secrets.WEB_EXT_API_SECRET }}
        run: npm run submit

      - name: Publish the GitHub release
        env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ steps.version.outputs.new_version }}
        run: |
          gh release create "v${VERSION}" \
            --title "v${VERSION}" \
            --generate-notes \
            "dist/configurable-containers-${VERSION}.xpi" \
            "dist/configurable-containers-src-${VERSION}.zip"
```

- [ ] **Step 2: Validate the workflow parses**

Run: `npx --yes @action-validator/cli --verbose .github/workflows/release.yaml` (or push the branch and let `check-actions.yaml` run).
Expected: no errors. If the validator is unavailable, at minimum run `npx --yes js-yaml .github/workflows/release.yaml > /dev/null` to confirm it is valid YAML.

- [ ] **Step 3: Document installation and building**

Replace README's `## Status` section with:

```markdown
## Install

Configurable Containers is published on addons.mozilla.org. Install it from its
listing page; Firefox keeps it updated.

On first run it seeds a commented example config that routes nothing — every site
opens in a fresh temporary container until you add rules. Edit the config in the
add-on's preferences (about:addons → Configurable Containers → Preferences), which
opens a full-tab text editor. Saving reloads the extension.

## Building from source

Requires Node 22 and a system Firefox for the end-to-end tests.

```
npm ci
npm run typecheck
npm test        # unit + e2e; launches real Firefox via Selenium
npm run package # -> dist/configurable-containers-<version>.xpi
```

`npm run package` bundles `src/extension/background.ts` and the two page scripts with
esbuild and stages them, with `extensions/cc/manifest.json`, into `dist/cc/`. Releases
are cut by `.github/workflows/release.yaml`, which stamps the version from a CalVer tag
and submits to AMO.

## Status

Published, and still shaped by the author's daily use. Built on Firefox's container
APIs, with the door left open to other browsers later.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yaml README.md
git commit --message "ci: CalVer-tagged release that packages, submits to AMO, and publishes"
```

- [ ] **Step 5: Final full-suite run**

Run: `npm test && npm run typecheck`
Expected: PASS throughout, no type errors.

---

## Manual steps this plan cannot do for you

These need your credentials and judgment; the plan stops at the repo boundary.

1. **Create the AMO listing** through the Developer Hub for `configurable-containers@k5d.de`, filling in summary, description, category, license, and the data-collection declaration (CC collects and transmits nothing). Do this before the first workflow run.
2. **Generate AMO API credentials** and store them as the repository secrets `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`.
3. **Paste your own config** into the editor after installing, from `configurable-containers.config.yaml`. That file stays in the repo as the `npm run manual` injection source and your backup; it is no longer shipped.
4. **Verify interactively** (`npm run manual`) that the options page behaves — Claude never launches this; it is yours to drive.
