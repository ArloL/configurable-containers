# Choice Screen + Reopen Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the keyboard-driven picker for multi-`open` rules — the automatic
**choice screen** (`onChoice`, currently a no-op stub) and the manual **reopen picker**
(keyboard command). Both surface a bundled extension page and reopen into the chosen
container through the engine's F1-guarded `reopen`. Closes the last non-F9 TESTS.md
feature surface.

**Architecture:** `createEngine` returns `{ reopen }` (the F1-guarded reopen effect,
extracted from `case "reopen"`). A new **`picker`** sibling owns `onChoice` (choice
screen), the `reopen-picker` command, and the `cc-pick` message listener. A stateless
**choice page** (`choice.html` + `choice.ts`) renders options, reports selection via
`runtime.sendMessage`, and fail-opens on a thrown reopen. Both flows converge on
`engine.reopen`. See the design spec for full rationale.

**Tech Stack:** TypeScript (ESM), Vitest, esbuild, Selenium/geckodriver, `@types/firefox-webext-browser`.

**Design spec:** `docs/superpowers/specs/2026-07-27-choice-screen-design.md`

## Global Constraints

- **Do not change** `src/resolver/resolve.ts`, `src/resolver/types.ts`,
  `src/matcher/matcher.ts`, `src/engine/registry.ts`, `src/engine/disposer.ts`,
  `src/engine/cookie-seeder.ts`, `src/engine/script-injector.ts`,
  `src/engine/redirector-closer.ts`, or `src/config/parse.ts`. The resolver already
  emits `{kind:"choice"}`; the parser already parses multi-`open` + `default`. This slice
  **adds** a picker sibling + a choice page + port seams + an engine method; it does not
  alter routing, disposal, or overlays.
- **F1 (reopen loop):** the picker's reopen **must** go through `engine.reopen` so the
  reopened tab's first `onBeforeRequest` hits the `freshlyReopened` guard. Never reopen
  by hand in the picker.
- **F2 (already eligible):** the resolver returns `stay` for a tab already in an eligible
  container; the engine never calls `onChoice`. Do not re-check eligibility in the picker.
- **Keyboard-driven selection is non-negotiable** (CONFIG.md). The choice page accepts
  number/letter keys (primary) and click (secondary, for L4 robustness); the L4 test
  exercises the keyboard path.
- **No `sendMessage` on `BrowserPort`** — the port is the background-only seam; the choice
  page uses `browser.runtime.sendMessage` directly. The port gains `onMessage`
  (background side, returns the handler's result so the page gets a response).
- **Keep `fileParallelism: false`** (do not touch `vitest.config.ts`).
- **Use CLI long options** (`--run`, `--save-dev`).
- **Commit after every task.**

---

### Task 1: Extract `engine.reopen` (F1-guarded) + return `{ reopen }`

**Files:**
- Modify: `src/engine/engine.ts`
- Modify: `test/engine/engine.test.ts`

**Interfaces:**
- `createEngine` returns `Engine` (new exported interface) with `reopen(tab: Tab, url: string, target: Target): Promise<void>`.
- `reopen` throws on failure (does not swallow); the engine's `case "reopen"` wraps the call in the existing `try/catch` (preserving `handled` clearing + fail-open).

- [ ] **Step 1: Write the failing test**

Add to `test/engine/engine.test.ts` a new `describe("engine.reopen", ...)`:

```ts
import type { Tab } from "../../src/engine/port";

describe("engine.reopen — extracted F1-guarded effect", () => {
  it("reopens a tab into the target container, preserving placement, and guards the reopened tab's first nav", async () => {
    const mp = createMockPort();
    const old = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default", index: 3, active: true, openerTabId: 7 });
    const engine = createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    await engine.reopen(old, "https://example.com/", { kind: "permanent", name: "Work" });

    expect(mp.calls.createTab).toHaveLength(1);
    const created = mp.calls.createTab[0];
    const work = (await mp.port.queryIdentities()).find((c) => c.name === "Work")!;
    expect(created).toMatchObject({ url: "https://example.com/", cookieStoreId: work.cookieStoreId, index: 3, active: true, openerTabId: 7 });
    expect(mp.calls.removeTab).toEqual([old.id]);

    // F1 guard: the reopened tab's first onBeforeRequest is a no-op (it fires before url commits).
    const newTab = [...mp.tabs.values()].find((t) => t.id !== old.id)!;
    newTab.url = "about:blank";
    const res = await mp.fire(req({ requestId: "2", tabId: newTab.id }));
    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(1); // no second reopen
  });

  it("reopen into Temporary creates a tmp-prefixed container", async () => {
    const mp = createMockPort();
    const old = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const engine = createEngine({ port: mp.port, config: { rules: [], groups: [] }, deps, onChoice: noop, tmpSuffix: counter() });

    await engine.reopen(old, "https://example.com/", { kind: "temporary" });

    expect(mp.calls.createIdentity).toHaveLength(1);
    expect(mp.calls.createIdentity[0].name).toMatch(/^tmp/);
    expect(mp.calls.removeTab).toEqual([old.id]);
  });

  it("reopen throws when createTab fails (does not swallow)", async () => {
    const mp = createMockPort();
    const old = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    mp.setCreateTabThrows(true);
    const engine = createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    await expect(engine.reopen(old, "https://example.com/", { kind: "permanent", name: "Work" })).rejects.toThrow();
    expect(mp.calls.removeTab).toEqual([]); // old tab not removed on failure
  });
});
```

- [ ] **Step 2: Make it pass**

In `src/engine/engine.ts`:
- Export `interface Engine { reopen(tab: Tab, url: string, target: Target): Promise<void>; }`.
- Change `createEngine` return type to `Engine`.
- Extract the reopen body into `async function reopen(tab, url, target)` (a closure over `port`, `registry`, `freshlyReopened`) that does steps 1–4 from spec §3 and **throws** on failure (no try/catch inside).
- `case "reopen"` becomes:
  ```ts
  case "reopen": {
    if (await macOwns(port, d.url)) return; // F7 defer
    handled.add(key);
    try {
      await reopen(tab, d.url, decision.into);
    } catch (e) {
      handled.delete(key); // fail open — allow a retry
      console.warn("[engine] reopen failed", e);
      return; // do NOT cancel
    }
    return { cancel: true };
  }
  ```
- Return `{ reopen }` from `createEngine`.

- [ ] **Step 3: Run the tests**

Run: `npx vitest --run test/engine/engine.test.ts`
Expected: all pass (existing tests unchanged in behaviour — they discard the return value; new reopen tests pass).

- [ ] **Step 4: Typecheck + regression**

Run: `npm run typecheck && npx vitest --run test/engine/ test/resolver/ test/matcher/`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts test/engine/engine.test.ts
git commit -m "feat(engine): extract F1-guarded reopen + return { reopen } from createEngine"
```

---

### Task 2: Port seam additions (`updateTab`, `onMessage`, `onCommand`, `getActiveTab`, `getURL`)

**Files:**
- Modify: `src/engine/port.ts`
- Modify: `src/engine/browser-port.ts`
- Modify: `test/engine/mock-port.ts`

**Interfaces (add to `BrowserPort`):**
- `updateTab(tabId: number, props: { url: string }): Promise<void>`
- `onMessage(handler: (msg: unknown) => unknown | Promise<unknown>): void`
- `onCommand(handler: (name: string) => void): void`
- `getActiveTab(): Promise<Tab | null>`
- `getURL(path: string): string` (sync)

- [ ] **Step 1: Add the types to `port.ts`**

Add to `BrowserPort` (beside the existing methods, in the same mechanical style):

```ts
// Choice screen / reopen picker — navigate the triggering tab to the choice page.
updateTab(tabId: number, props: { url: string }): Promise<void>;
// Choice page → background: selection message; returns the handler's result so the page
// gets a response ({ok:true}/{ok:false}).
onMessage(handler: (msg: unknown) => unknown | Promise<unknown>): void;
// Reopen picker keyboard command.
onCommand(handler: (name: string) => void): void;
// The active tab in the current window (for the reopen picker). Null if none.
getActiveTab(): Promise<Tab | null>;
// The full moz-extension:// URL for a bundled resource (e.g. "choice.html").
getURL(path: string): string;
```

- [ ] **Step 2: Real adapter in `browser-port.ts`**

```ts
async updateTab(tabId, props) {
  await browser.tabs.update(tabId, { url: props.url });
},
onMessage(handler) {
  browser.runtime.onMessage.addListener((msg) => handler(msg) as never);
},
onCommand(handler) {
  browser.commands.onCommand.addListener((name) => handler(name));
},
async getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const t = tabs[0];
  return t ? mapTab(t) : null;
},
getURL(path) {
  return browser.runtime.getURL(path);
},
```

- [ ] **Step 3: Mock in `mock-port.ts`**

Add to the `MockPort` interface and implementation:
- `updateTabUrl: number[]` is too narrow; track `updates: { tabId: number; url: string }[]` in `calls`.
- `onMessage`/`onCommand`: store the handler; expose `emitMessage(msg): Promise<unknown>` and `emitCommand(name: string): Promise<void>` so tests can fire them.
- `getActiveTab`: a settable `activeTabId` (or a field `activeTab: Tab | null`); default null. Add `setActiveTab(tab: Tab): void`.
- `getURL`: return `moz-extension://test/<path>`.

```ts
// in calls:
updates: [] as { tabId: number; url: string }[];

// on the mock object:
async updateTab(tabId, props) {
  calls.updates.push({ tabId, url: props.url });
  const t = tabs.get(tabId);
  if (t) tabs.set(tabId, { ...t, url: props.url });
},
let messageH: ((msg: unknown) => unknown | Promise<unknown>) | null = null;
onMessage(h) { messageH = h; },
async emitMessage(msg) {
  if (!messageH) throw new Error("no onMessage handler");
  return messageH(msg);
},
let commandH: ((name: string) => void) | null = null;
onCommand(h) { commandH = h; },
async emitCommand(name) { commandH?.(name); await flushMicrotasks(); },
let activeTab: Tab | null = null;
async getActiveTab() { return activeTab; },
setActiveTab(tab: Tab) { activeTab = tab; },
getURL(path) { return `moz-extension://test/${path}`; },
```

Expose `emitMessage`, `emitCommand`, `setActiveTab` on the returned `MockPort`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean (all three files type-consistent).

- [ ] **Step 5: Commit**

```bash
git add src/engine/port.ts src/engine/browser-port.ts test/engine/mock-port.ts
git commit -m "feat(engine): port seam for tabs.update, runtime.onMessage, commands, active tab, getURL"
```

---

### Task 3: Picker protocol (pure) + choice page + bundle

**Files:**
- Create: `src/extension/picker-protocol.ts`
- Test: `test/extension/picker-protocol.test.ts`
- Create: `extensions/cc/choice.html`
- Create: `src/extension/choice.ts`
- Modify: `harness/build-extension.ts`

**Interfaces:**
- `encodePayload(p: { tabId: number; url: string; options: string[] }): string`
- `decodePayload(s: string): { tabId: number; url: string; options: string[] }`
- `choiceKeys(n: number): string[]` — `["1".."9", "a".."z"]` (enough for any realistic rule; throws if n > 35).
- `PickMessage = { type: "cc-pick"; tabId: number; url: string; container: string }`
- `PickResponse = { ok: boolean }`

- [ ] **Step 1: Write the failing test**

`test/extension/picker-protocol.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encodePayload, decodePayload, choiceKeys } from "../../src/extension/picker-protocol";

describe("picker-protocol", () => {
  it("encodes and decodes a payload round-trip", () => {
    const p = { tabId: 7, url: "http://figma.example:1234/", options: ["Personal", "Work"] };
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });

  it("survives container names with spaces and special chars", () => {
    const p = { tabId: 1, url: "http://x.test/", options: ["My Container", "a,b"] };
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });

  it("choiceKeys: 1..9 then a..z", () => {
    expect(choiceKeys(2)).toEqual(["1", "2"]);
    expect(choiceKeys(9)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(choiceKeys(11)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b"]);
  });

  it("choiceKeys throws for more than 35 options (unrealistic)", () => {
    expect(() => choiceKeys(36)).toThrow();
  });
});
```

- [ ] **Step 2: Implement `picker-protocol.ts`**

```ts
export interface PickMessage { type: "cc-pick"; tabId: number; url: string; container: string }
export interface PickResponse { ok: boolean }
export interface ChoicePayload { tabId: number; url: string; options: string[] }

export function encodePayload(p: ChoicePayload): string {
  return encodeURIComponent(JSON.stringify(p));
}
export function decodePayload(s: string): ChoicePayload {
  return JSON.parse(decodeURIComponent(s)) as ChoicePayload;
}
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
export function choiceKeys(n: number): string[] {
  const all = [...DIGITS, ...LETTERS];
  if (n > all.length) throw new Error(`too many options (${n}); max ${all.length}`);
  return all.slice(0, n);
}
```

- [ ] **Step 3: Run the test**

Run: `npx vitest --run test/extension/picker-protocol.test.ts`
Expected: PASS.

- [ ] **Step 4: Create `extensions/cc/choice.html`**

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Choose container</title></head>
<body>
  <p id="cc-dest"></p>
  <ul id="cc-options"></ul>
  <p id="cc-status" hidden></p>
  <script src="choice.js"></script>
</body></html>
```

- [ ] **Step 5: Create `src/extension/choice.ts`**

The page reads `location.hash`, decodes the payload, renders `<li data-cc-option data-key data-container>`, and on keydown/click sends `browser.runtime.sendMessage` and awaits the response. On `{ok:true}` show "Opening…"; on `{ok:false}` navigate back to `url`. Esc navigates back to `url`.

```ts
import { decodePayload, choiceKeys, type PickMessage, type PickResponse } from "./picker-protocol";

const payload = decodePayload(location.hash.slice(1));
const keys = choiceKeys(payload.options.length);

document.getElementById("cc-dest")!.textContent = "Opening: " + payload.url;

const list = document.getElementById("cc-options")!;
payload.options.forEach((container, i) => {
  const li = document.createElement("li");
  li.setAttribute("data-cc-option", "");
  li.setAttribute("data-key", keys[i]);
  li.setAttribute("data-container", container);
  li.textContent = `${keys[i]} · ${container}`;
  li.tabIndex = 0;
  list.appendChild(li);
});

async function pick(container: string) {
  const status = document.getElementById("cc-status")!;
  status.hidden = false;
  status.textContent = "Opening " + container + "…";
  const msg: PickMessage = { type: "cc-pick", tabId: payload.tabId, url: payload.url, container };
  try {
    const res = (await browser.runtime.sendMessage(msg)) as PickResponse | undefined;
    if (res && !res.ok) {
      // reopen failed — fail open back to the url
      location.href = payload.url;
    }
    // else: the background's reopen closed this tab; nothing to do
  } catch {
    location.href = payload.url; // no handler / background gone — fail open
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { location.href = payload.url; return; }
  const li = list.querySelector<HTMLElement>(`[data-key="${e.key}"]`);
  if (li) pick(li.getAttribute("data-container")!);
});

list.addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("[data-cc-option]");
  if (li) pick(li.getAttribute("data-container")!);
});
```

- [ ] **Step 6: Bundle `choice.ts` in `build-extension.ts`**

Change the esbuild `build` to multi-entry (or add a second build call):

```ts
await build({
  entryPoints: [ENTRY, path.resolve(HERE, "../src/extension/choice.ts")],
  bundle: true,
  outdir: path.resolve(HERE, "../extensions/cc"),
  // ... rest unchanged; use outdir instead of outfile
  format: "iife",
  platform: "browser",
  target: "firefox115",
  logLevel: "silent",
  define: { __CC_GRACE_MS__: ..., __CC_REDIRECTOR_DELAY_MS__: ... },
});
```

Note: switch from `outfile` to `outdir` (esbuild infers `background.js` + `choice.js` from entry names). Verify `extensions/cc/background.js` still produced.

- [ ] **Step 7: Commit**

```bash
git add src/extension/picker-protocol.ts src/extension/choice.ts extensions/cc/choice.html test/extension/picker-protocol.test.ts harness/build-extension.ts
git commit -m "feat(extension): keyboard-driven choice page + pure picker protocol"
```

---

### Task 4: The picker sibling (`src/engine/picker.ts`)

**Files:**
- Create: `src/engine/picker.ts`
- Test: `test/engine/picker.test.ts`

**Interfaces:**
- `createPicker({ port, config, deps, reopen }): { showChoice(tabId, url, options): Promise<void> }`
- `showChoice` navigates the triggering tab to `getURL("choice.html") + "#" + encodePayload(...)`.
- Registers `onMessage` (handles `cc-pick` → `reopen` → returns `{ok}`) and `onCommand` (reopen picker).
- Maps `container === "Temporary"` → `{kind:"temporary"}`, else `{kind:"permanent",name}`.

- [ ] **Step 1: Write the failing test**

`test/engine/picker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import { createPicker } from "../../src/engine/picker";
import { parseConfig } from "../../src/config/parse";
import { matchRule, matchGroup } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Tab, Target } from "../../src/engine/port";

const deps = { matchRule, matchGroup, sameSite };
const config = parseConfig(`
rules:
  - match: figma.example
    open: [Personal, Work]
  - match: youtube.example
    open: [Temporary, Personal]
    default: Temporary
  - match: work.example
    open: Work
`);

function fakeReopen(): { reopen: (tab: Tab, url: string, t: Target) => Promise<void>; calls: Array<{ tabId: number; url: string; target: Target }> } {
  const calls: Array<{ tabId: number; url: string; target: Target }> = [];
  return {
    reopen: async (tab, url, target) => { calls.push({ tabId: tab.id, url, target }); },
    calls,
  };
}

describe("picker — choice screen (onChoice flow)", () => {
  it("showChoice navigates the triggering tab to the choice page with the encoded payload", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://figma.example/", cookieStoreId: "firefox-default" });
    const fr = fakeReopen();
    const picker = createPicker({ port: mp.port, config, deps, reopen: fr.reopen });
    await picker.showChoice(tab.id, "https://figma.example/", ["Personal", "Work"]);

    expect(mp.calls.updates).toHaveLength(1);
    expect(mp.calls.updates[0].tabId).toBe(tab.id);
    expect(mp.calls.updates[0].url).toContain("moz-extension://test/choice.html#");
    expect(decodeURIComponent(mp.calls.updates[0].url.split("#")[1])).toContain('"options":["Personal","Work"]');
  });

  it("onMessage cc-pick reopens into the chosen permanent container and returns {ok:true}", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://figma.example/", cookieStoreId: "firefox-default", index: 2, active: true });
    const fr = fakeReopen();
    createPicker({ port: mp.port, config, deps, reopen: fr.reopen });

    const res = await mp.emitMessage({ type: "cc-pick", tabId: tab.id, url: "https://figma.example/", container: "Work" });

    expect(res).toEqual({ ok: true });
    expect(fr.calls).toEqual([{ tabId: tab.id, url: "https://figma.example/", target: { kind: "permanent", name: "Work" } }]);
  });

  it("onMessage cc-pick maps 'Temporary' to a {kind:'temporary'} target", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://youtube.example/", cookieStoreId: "firefox-default" });
    const fr = fakeReopen();
    createPicker({ port: mp.port, config, deps, reopen: fr.reopen });

    await mp.emitMessage({ type: "cc-pick", tabId: tab.id, url: "https://youtube.example/", container: "Temporary" });

    expect(fr.calls[0].target).toEqual({ kind: "temporary" });
  });

  it("onMessage returns {ok:false} when reopen throws (fail-open signal to the page)", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://figma.example/", cookieStoreId: "firefox-default" });
    const fr = fakeReopen();
    fr.reopen = async () => { throw new Error("boom"); };
    createPicker({ port: mp.port, config, deps, reopen: fr.reopen });

    const res = await mp.emitMessage({ type: "cc-pick", tabId: tab.id, url: "https://figma.example/", container: "Work" });

    expect(res).toEqual({ ok: false });
  });

  it("onMessage ignores unrelated messages (returns undefined)", async () => {
    const mp = createMockPort();
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });
    const res = await mp.emitMessage({ type: "something-else" });
    expect(res).toBeUndefined();
  });
});

describe("picker — reopen picker (command flow)", () => {
  it("onCommand reopen-picker shows the choice page with the active tab's matching rule containers", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "http://figma.example:1234/", cookieStoreId: "firefox-default", active: true });
    mp.setActiveTab(tab);
    const fr = fakeReopen();
    const picker = createPicker({ port: mp.port, config, deps, reopen: fr.reopen });

    await mp.emitCommand("reopen-picker");

    expect(mp.calls.updates).toHaveLength(1);
    expect(mp.calls.updates[0].tabId).toBe(tab.id);
    expect(decodeURIComponent(mp.calls.updates[0].url.split("#")[1])).toContain('"options":["Personal","Work"]');
  });

  it("onCommand reopen-picker with a single-open rule does nothing (nothing to choose)", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "http://work.example:1234/", cookieStoreId: "firefox-default" });
    mp.setActiveTab(tab);
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });

    await mp.emitCommand("reopen-picker");

    expect(mp.calls.updates).toEqual([]);
  });

  it("onCommand reopen-picker with no matching rule does nothing (undecided unmatched case)", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "http://nomatch.example:1234/", cookieStoreId: "firefox-default" });
    mp.setActiveTab(tab);
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });

    await mp.emitCommand("reopen-picker");

    expect(mp.calls.updates).toEqual([]);
  });

  it("onCommand reopen-picker with no active tab does nothing", async () => {
    const mp = createMockPort();
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });
    await mp.emitCommand("reopen-picker");
    expect(mp.calls.updates).toEqual([]);
  });

  it("onCommand ignores an unknown command name", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "http://figma.example:1234/", cookieStoreId: "firefox-default" });
    mp.setActiveTab(tab);
    createPicker({ port: mp.port, config, deps, reopen: fakeReopen().reopen });
    await mp.emitCommand("something-else");
    expect(mp.calls.updates).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement `src/engine/picker.ts`**

```ts
import type { Config, Deps, Target } from "../resolver/types";
import { TEMPORARY } from "../resolver/types";
import type { BrowserPort, Tab } from "./port";
import { encodePayload, type PickMessage, type PickResponse } from "../extension/picker-protocol";

export interface PickerOptions {
  port: BrowserPort;
  config: Config;
  deps: Pick<Deps, "matchRule">;
  reopen: (tab: Tab, url: string, target: Target) => Promise<void>;
}

export interface Picker {
  showChoice(tabId: number, url: string, options: string[]): Promise<void>;
}

const REOPEN_PICKER_COMMAND = "reopen-picker";

function containerToTarget(container: string): Target {
  return container === TEMPORARY ? { kind: "temporary" } : { kind: "permanent", name: container };
}

export function createPicker(opts: PickerOptions): Picker {
  const { port, config, deps, reopen } = opts;

  async function showChoice(tabId: number, url: string, options: string[]): Promise<void> {
    const choiceUrl = port.getURL("choice.html") + "#" + encodePayload({ tabId, url, options });
    await port.updateTab(tabId, { url: choiceUrl });
  }

  port.onMessage(async (msg) => {
    const m = msg as PickMessage;
    if (m?.type !== "cc-pick") return undefined;
    const tab = await port.getTab(m.tabId);
    if (!tab) return { ok: false } satisfies PickResponse;
    try {
      await reopen(tab, m.url, containerToTarget(m.container));
      return { ok: true } satisfies PickResponse;
    } catch {
      return { ok: false } satisfies PickResponse;
    }
  });

  port.onCommand((name) => {
    if (name !== REOPEN_PICKER_COMMAND) return;
    void (async () => {
      const tab = await port.getActiveTab();
      if (!tab) return;
      const rule = deps.matchRule(tab.url, config.rules);
      if (!rule || rule.action.kind !== "open" || rule.action.containers.length < 2) return;
      void showChoice(tab.id, tab.url, rule.action.containers);
    })();
  });

  return { showChoice };
}
```

- [ ] **Step 3: Run the test**

Run: `npx vitest --run test/engine/picker.test.ts`
Expected: PASS (all choice-screen + reopen-picker cases).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/picker.ts test/engine/picker.test.ts
git commit -m "feat(engine): picker sibling — choice screen + reopen picker"
```

---

### Task 5: Wiring (`background.ts` + manifest + bundled config + harness)

**Files:**
- Modify: `src/extension/background.ts`
- Modify: `extensions/cc/manifest.json`
- Modify: `harness/firefox.ts`

- [ ] **Step 1: Wire the picker in `background.ts`**

```ts
import { createPicker } from "../engine/picker";

const engine = createEngine({
  port, config, deps: { matchRule, matchGroup, sameSite },
  onChoice: (options, nav) => { void picker.showChoice(nav.tabId, nav.url, options); },
});

const picker = createPicker({ port, config, deps: { matchRule }, reopen: engine.reopen });
```

Note the `picker` forward-reference: `onChoice` closes over `picker` which is assigned on the next line. Because `onChoice` is only *called* later (at navigation time, not at construction), the forward reference is safe. If the linter complains, hoist `picker` with `let`:

```ts
let picker: ReturnType<typeof createPicker>;
const engine = createEngine({
  port, config, deps: { matchRule, matchGroup, sameSite },
  onChoice: (options, nav) => { void picker.showChoice(nav.tabId, nav.url, options); },
});
picker = createPicker({ port, config, deps: { matchRule }, reopen: engine.reopen });
```

Add choice + default-Temporary rules to `BUNDLED_CONFIG_YAML`:

```yaml
rules:
  - match: work.example
    open: Work
    cookies:
      - { name: seed, url: "http://work.example/", value: "1" }
    scripts:
      - { at: document_start, run: "localStorage.setItem('cc_script', '1');" }
  - match: redirect.example
    redirector: true
  - match: figma.example
    open: [Personal, Work]
  - match: youtube.example
    open: [Temporary, Personal]
    default: Temporary
```

- [ ] **Step 2: Add the command to `manifest.json`**

```json
"commands": {
  "reopen-picker": {
    "suggested_key": { "default": "Ctrl+Shift+O" },
    "description": "Reopen this tab in a container"
  }
}
```

- [ ] **Step 3: Add test domains to `harness/firefox.ts`**

Change the `localDomains` pref to include the choice test domains:

```ts
options.setPreference("network.dns.localDomains", "work.example,nomatch.example,redirect.example,figma.example,youtube.example");
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npx vitest --run test/engine/ test/extension/`
Expected: clean. (The build runs at L4 time; verify `harness/build-extension.ts` still emits `background.js` + `choice.js`.)

- [ ] **Step 5: Commit**

```bash
git add src/extension/background.ts src/extension/config.ts extensions/cc/manifest.json harness/firefox.ts
git commit -m "feat(extension): wire picker + choice/youtube rules + reopen-picker command"
```

---

### Task 6: L4 e2e — choice screen + reopen picker (real Firefox)

**Files:**
- Create: `test/e2e/choice.test.ts`

**Scenarios (TESTS.md):**
- "Multi-open without a default shows a choice screen" → choose via keyboard → reopens into chosen container.
- "A choice is never remembered" → a second fresh navigation re-shows the choice page.
- "The reopen picker is restricted to the rule's containers" → command on a default-Temporary tab → choose Personal → reopens.

- [ ] **Step 1: Write the L4 test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By, Key } from "selenium-webdriver";
import { launch, awaitContainerTab, type Session } from "../../harness/firefox";

describe("choice screen + reopen picker (real Firefox, CC + probe)", () => {
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
      // CC cancelled the nav to show the choice page — expected.
    }
  }

  // Poll handles until one is on the choice page (moz-extension://.../choice.html).
  async function awaitChoicePage(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const handle of await session.driver.getAllWindowHandles()) {
        try {
          await session.driver.switchTo().window(handle);
          if ((await session.driver.getCurrentUrl()).includes("/choice.html")) return;
        } catch {
          // handle closed — skip
        }
      }
      await session.driver.sleep(100);
    }
    throw new Error("choice page did not appear");
  }

  it("shows a keyboard choice screen for a multi-open-no-default rule and reopens into the chosen container", async () => {
    const url = `http://figma.example:${port}/`;
    await navFreshTab(url);
    await awaitChoicePage();

    // The page rendered the options; read them to find the key for "Work".
    const opts = await session.driver.findElements(By.css("[data-cc-option]"));
    expect(opts.length).toBe(2);
    const containers = await Promise.all(opts.map((o) => o.getAttribute("data-container")));
    expect(containers.sort()).toEqual(["Personal", "Work"]);
    const workLi = opts[await containers.indexOf("Work") === -1 ? 0 : containers.indexOf("Work")];
    const workKey = await workLi.getAttribute("data-key");

    // Keyboard selection (non-negotiable path).
    await session.driver.actions().sendKeys(workKey).perform();

    const { name } = await awaitContainerTab(session.driver, url);
    expect(name).toBe("Work");
  });

  it("a choice is never remembered — a fresh nav re-shows the choice page", async () => {
    const url = `http://figma.example:${port}/`;
    await navFreshTab(url);
    await awaitChoicePage();
    // (Don't pick — just confirm the page appeared again. Close it to clean up.)
    expect((await session.driver.getCurrentUrl()).includes("/choice.html")).toBe(true);
  });

  it("reopen picker: command on a default-Temporary tab offers the rule's list and reopens into Personal", async () => {
    const url = `http://youtube.example:${port}/`;
    await navFreshTab(url);
    // Routes to a fresh tmp (default Temporary) — wait for it.
    const { name } = await awaitContainerTab(session.driver, url);
    expect(name).toMatch(/^tmp/);

    // Invoke the reopen-picker command.
    await session.driver.actions()
      .keyDown(Key.CONTROL).keyDown(Key.SHIFT).sendKeys("o")
      .keyUp(Key.SHIFT).keyUp(Key.CONTROL).perform();
    await awaitChoicePage();

    const opts = await session.driver.findElements(By.css("[data-cc-option]"));
    const containers = await Promise.all(opts.map((o) => o.getAttribute("data-container")));
    expect(containers.sort()).toEqual(["Personal", "Temporary"]); // restricted to the rule's list
    const personalIdx = containers.indexOf("Personal");
    const personalKey = await opts[personalIdx].getAttribute("data-key");
    await session.driver.actions().sendKeys(personalKey).perform();

    const { name: after } = await awaitContainerTab(session.driver, url);
    expect(after).toBe("Personal");
  });
});
```

- [ ] **Step 2: Run the L4 test**

Run: `npx vitest --run test/e2e/choice.test.ts`
Expected: PASS (3 tests). It launches real Firefox with CC + probe.

If the command test is flaky (headless `Ctrl+Shift+O` not firing `onCommand`), debug:
- Confirm `manifest.json` has the `commands` entry and the build included it (re-check `extensions/cc/manifest.json` is zipped).
- Confirm the active tab is focused when the chord is sent (the `awaitContainerTab` leaves the driver on the youtube tab).
- As a fallback for the command trigger only, the L3 test already proves the handler logic; do **not** weaken the choice-page/keyboard assertions to make the L4 pass. If the command genuinely cannot be driven headless, mark that one `it` with `.skip` and open an issue — but the choice-screen tests must pass.

- [ ] **Step 3: Run the full suite (regression)**

Run: `npx vitest --run`
Expected: all suites pass — unit (config, overlays, engine, matcher, psl, resolver, picker, picker-protocol), extension unit, and the e2e (plumbing, routing, disposal, cookies, scripts, redirector, choice).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/choice.test.ts
git commit -m "test(e2e): L4 choice screen + reopen picker — keyboard selection, never remembered, restricted list"
```

---

## Self-review notes (author)

- **Spec coverage:** §1 goal/scope → Tasks 1–6; §2 architecture (picker sibling, choice page, reopen convergence) → Tasks 1,3,4,5; §3 reopen extraction (F1 guard, throws) → Task 1; §4 choice page (stateless, keyboard+click, fail-open round-trip) → Task 3; §5 port seam (updateTab, onMessage round-trip, onCommand, getActiveTab, getURL) → Task 2; §6 wiring (background, manifest commands, bundled config, localDomains) → Task 5; §7 testing (L3 picker, L3 engine reopen, L4 choice + reopen picker) → Tasks 1,4,6; §8 risks (F1 via engine.reopen, F2 resolver stay, focus, command flakiness, URL length) → Tasks 1,4,6. No spec section is unmapped.
- **F1 at the choice reopen — mechanism:** the picker never reopens by hand; it calls `engine.reopen`, which adds the new tab to `freshlyReopened`. Task 1's L3 test asserts the reopened tab's first `onBeforeRequest` is a no-op (the load-bearing guard from CLAUDE.md). This is the one thing mocks must prove that the choice flow can't break.
- **F2 (already eligible):** the resolver returns `stay` and `onChoice` is never called — no choice page. The picker does not re-check eligibility (the engine already did). Covered by existing resolver tests; the L4 "no prompt when already in an eligible container" is implicit (re-navigating from within Work stays, no choice page) — not a separate L4 case here, but the resolver tests own it.
- **Keyboard non-negotiable:** the L4 test sends a real key (`sendKeys(workKey)`) read from the rendered `data-key` — it proves the keyboard path end to end. Click is secondary (page supports it; not the tested path).
- **Never remembered:** inherent (no storage); L4 proves it by re-navigating and asserting the choice page reappears.
- **Coexistence with the other siblings:** the bundled `figma.example` and `youtube.example` rules carry no cookies/scripts/redirector; the existing `work.example` (overlays) and `redirect.example` rules are untouched. The L4 choice test asserts the choice page + reopen, proving the picker doesn't interfere with the engine/disposer/seeder/injector/closer.
