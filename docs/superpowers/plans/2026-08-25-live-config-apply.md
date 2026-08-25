# Live Config Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a saved or adopted config into effect in process, so `browser.runtime.reload()` leaves `src/` entirely and a config save becomes observable on every Firefox channel.

**Architecture:** `wireBackground` gains `applyStored()` — read the stored yaml through the port's existing `readStored`, `Object.assign` it into the one `config` object every sibling reads at event time, then hand the new config to a script injector that now holds and replaces its registrations. The options page sends `cc-config-apply` and reports on the reply instead of reloading; config-sync's `adopt` calls the same function.

**Tech Stack:** TypeScript, Firefox MV2 WebExtension, esbuild, Vitest (L1–L3) + Selenium/geckodriver (L4).

**Spec:** `docs/superpowers/specs/2026-08-25-live-config-apply-design.md`

## Global Constraints

Copied from the spec and `CLAUDE.md`. Every task's requirements implicitly include these.

- **`wireBackground` never awaits.** Every `browser.*` listener registers synchronously as `background.ts` evaluates; the session's first navigation is lost otherwise.
- **`config` is filled IN PLACE.** Handing a sibling a freshly parsed object leaves it holding the empty one.
- **One `runtime.onMessage` registration**, in `wireBackground`, dispatched by `type`. A sibling that does not own a message returns `undefined` **synchronously**; assert on the un-awaited return.
- **`wiring.ts` must not touch `browser.*`** — `test/fitness/seams.test.ts` pins the five files that may, as an exact list. Reach storage through `port.readStored`.
- **`mock-port` fidelity is where "L3 green, Firefox broken" comes from.** Never relax it.
- **Fitness tests are exact inventories, never bounds**, matched on stripped comments and identified by file, never line.
- **Revert-verify every regression test** — back the change out with an editor undo (never `git checkout`), watch it go red, restore it.
- **Prefer CLI long options** (`--silent`, not `-s`).
- **Do not write "load-bearing"** in prose, comments or commit messages. Say what requires the thing and what breaks without it.
- **Comments carry the non-obvious why.** Do not restate the code.
- Commit messages end with: `Claude-Session: https://claude.ai/code/session_018WcYkZNEhYEyw3FHG7WHct`

## File Structure

| File | Responsibility |
|---|---|
| `src/extension/config-protocol.ts` *(new)* | The `cc-config-apply` message name and its reply type. Pure, no browser, no DOM — mirrors `pause-protocol.ts`. |
| `src/engine/script-injector.ts` | Becomes an object that holds its `RegisteredContentScript` handles and can replace them. |
| `src/extension/wiring.ts` | `applyStored()`, the `cc-config-apply` branch, the injector's construction, `afterApply`. |
| `src/extension/options.ts` | Save sends the message and reports the reply; no `runtime.reload()`. |
| `src/extension/config-sync.ts` | `adopt` applies in process; `browserSyncPorts` takes the applier. |
| `src/extension/background.ts` | Builds `configSync` before `wireBackground`, passes `afterApply`, hands adoption a deferred applier. |
| `src/config/sync-record.ts` | Comment only: the convergence reason that cited the reload. |
| `test/engine/mock-port.ts` | `unregister()` actually unregisters. |
| `test/engine/apply-config.test.ts` *(new)* | The L3 suite for the apply. |
| `test/engine/script-injector.test.ts` | Re-apply cases. |
| `test/engine/restart.ts` | Startup calls the injector through its new shape. |
| `test/fitness/sources.ts` consumers | A row pinning `runtime.reload` out of `src/`; `retained-state.test.ts` prose. |
| `test/e2e/options.test.ts` | Drops the `< 154` skip. |

---

### Task 1: `unregister()` actually unregisters (mock-port fidelity)

`mock-port` returns `{ unregister: async () => {} }` and `registeredScripts` is append-only, so no L3 case can see a snippet that should have been removed — the whole risk of this slice would be invisible below L4.

**Files:**
- Modify: `test/engine/mock-port.ts` (`registerContentScript`, ~line 249)
- Test: `test/engine/mock-port.test.ts`

**Interfaces:**
- Produces: `browser.registeredScripts` reflects live registrations only.

- [x] **Step 1: Write the failing test**

Add to `test/engine/mock-port.test.ts`:

```ts
it("drops a content script from the live list when it is unregistered", async () => {
  const browser = aFakeBrowser();
  const reg = await browser.port.registerContentScript({
    matches: ["*://a.example/*"],
    js: [{ code: "a();" }],
    runAt: "document_start",
  });
  expect(browser.registeredScripts).toHaveLength(1);

  await reg.unregister();

  // Firefox stops injecting into new page loads; a mock that kept the entry would let a
  // stale snippet look registered forever, which is exactly what an apply has to remove.
  expect(browser.registeredScripts).toEqual([]);
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/engine/mock-port.test.ts`
Expected: FAIL — `registeredScripts` still has one entry.

- [x] **Step 3: Implement**

In `test/engine/mock-port.ts`, replace the registration:

```ts
    async registerContentScript(details: RegisterContentScriptDetails): Promise<RegisteredContentScript> {
      registeredScripts.push(details);
      // Removed by identity, as Firefox does: unregistering one handle must not disturb an
      // identical snippet registered separately (a config can name the same code twice).
      return {
        unregister: async () => {
          const at = registeredScripts.indexOf(details);
          if (at !== -1) registeredScripts.splice(at, 1);
        },
      };
    },
```

- [x] **Step 4: Run the suite**

Run: `npx vitest run test/engine`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add test/engine/mock-port.ts test/engine/mock-port.test.ts
git commit -m "test: let mock-port model unregistering a content script"
```

---

### Task 2: The injector holds its registrations

`createScriptInjector` registers once and throws away the handles the port already returns. It becomes an object with `apply(config)`, so first registration and every later one share one path.

**Files:**
- Modify: `src/engine/script-injector.ts`
- Modify: `src/extension/wiring.ts` (construct it; `injectScripts` delegates)
- Test: `test/engine/script-injector.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ScriptInjector { apply(config: Config): Promise<void>; }
  export function createScriptInjector(opts: { port: BrowserPort }): ScriptInjector;
  ```
  `apply` unregisters the handles from the previous call, then registers the current config's snippets in order. Rejects with the port's error if a registration fails.

- [x] **Step 1: Write the failing tests**

Rewrite the existing cases to the new shape (`createScriptInjector({ port })` then `await injector.apply(config)`) and add:

```ts
it("replaces its registrations on the next apply, leaving one per snippet", async () => {
  const browser = aFakeBrowser();
  const injector = createScriptInjector({ port: browser.port });
  const before = parseConfig(`rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`);
  const after = parseConfig(`rules:\n  - match: b.example\n    scripts:\n      - { run: "b();" }\n`);

  await injector.apply(before);
  await injector.apply(after);

  // Not "contains b": a re-apply that only added would inject the removed snippet forever,
  // and the user's only signal would be a page still being rewritten by a deleted rule.
  expect(browser.registeredScripts).toEqual([
    { matches: ["*://b.example/*", "*://*.b.example/*"], js: [{ code: "b();" }], runAt: "document_start" },
  ]);
});

it("registers the same snippet exactly once when a config is applied twice", async () => {
  const browser = aFakeBrowser();
  const injector = createScriptInjector({ port: browser.port });
  const config = parseConfig(`rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`);

  await injector.apply(config);
  await injector.apply(config);

  expect(browser.registeredScripts).toHaveLength(1);
});

it("drops every registration when the new config has no scripts", async () => {
  const browser = aFakeBrowser();
  const injector = createScriptInjector({ port: browser.port });
  await injector.apply(parseConfig(`rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`));

  await injector.apply(parseConfig(`rules:\n  - match: a.example\n    open: A\n`));

  expect(browser.registeredScripts).toEqual([]);
});
```

- [x] **Step 2: Run and watch it fail**

Run: `npx vitest run test/engine/script-injector.test.ts`
Expected: FAIL — `createScriptInjector` is not callable with one argument / has no `apply`.

- [x] **Step 3: Implement**

```ts
import type { Config } from "../resolver/types";
import type { BrowserPort, RegisteredContentScript } from "./port";
import { scriptRegistrations } from "../overlays/scripts";

export interface ScriptInjectorOptions {
  port: BrowserPort;
}

export interface ScriptInjector {
  apply(config: Config): Promise<void>;
}

// Registration-based, unlike the seeder's per-request listener: Firefox injects each snippet
// at runAt for matching pages (F12 — document_start runs before the page's own scripts). No
// cookieStoreId (F11): the script runs wherever the URL loads, so in the tab's own container
// after routing.
//
// The handles are kept because a config can be applied more than once now. Unregistering is
// unconditional rather than diffed against the previous set: at this size that is a handful
// of calls on an action the user performs by hand, and a diff is a second representation of
// the config to keep correct. It does NOT stop a snippet already running in an open page —
// nothing can; the extension restart this replaced could not either, since document_start
// means the code had already run.
export function createScriptInjector(opts: ScriptInjectorOptions): ScriptInjector {
  const { port } = opts;
  let live: RegisteredContentScript[] = [];

  return {
    async apply(config) {
      for (const reg of live) await reg.unregister();
      live = [];
      for (const reg of scriptRegistrations(config)) {
        live.push(
          await port.registerContentScript({
            matches: reg.matches,
            js: [{ code: reg.code }],
            runAt: reg.runAt,
          }),
        );
      }
    },
  };
}
```

In `src/extension/wiring.ts`, construct it beside the other siblings (synchronous — construction registers nothing) and delegate:

```ts
  const scripts = createScriptInjector({ port });
```

```ts
    async injectScripts() {
      await scripts.apply(config);
    },
```

- [x] **Step 4: Run**

Run: `npx vitest run test/engine && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/engine/script-injector.ts src/extension/wiring.ts test/engine/script-injector.test.ts
git commit -m "refactor: let the script injector replace its registrations"
```

---

### Task 3: `applyStored()` and the `cc-config-apply` message

**Files:**
- Create: `src/extension/config-protocol.ts`
- Modify: `src/extension/wiring.ts`
- Create test: `test/engine/apply-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/extension/config-protocol.ts
  export const CONFIG_APPLY = "cc-config-apply";
  export interface ConfigApplyResponse {
    scriptError?: string;   // a snippet failed to register; the new routing is already live
    configError?: string;   // the stored text does not parse; the empty config was applied
  }
  ```
  ```ts
  // src/extension/wiring.ts
  export interface WiringOptions { /* …existing… */ afterApply?: () => void }
  export interface Background { /* …existing… */ applyStored(): Promise<ConfigApplyResponse> }
  ```
  `applyStored` never rejects and never fires `afterApply` — the message branch does, so adoption does not re-enter the sync queue it is running inside.

- [x] **Step 1: Write the failing tests**

`test/engine/apply-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { startTheBackground } from "./restart";
import { parseConfig } from "../../src/config/parse";
import { CONFIG_APPLY } from "../../src/extension/config-protocol";
import { CONFIG_STORAGE_KEY } from "../../src/extension/config";
import type { Clock } from "../../src/engine/port";

const before = parseConfig(`rules:\n  - match: work.example\n    open: Work\n`);
const AFTER_YAML = `rules:\n  - match: nomatch.example\n    open: Editor\n`;

function aFakeClock(): Clock {
  return { setTimeout: () => {}, now: () => 0 };
}

// Saving used to be runtime.reload(): a fresh background read storage on the way up and
// every sibling saw the new config because nothing of the old one was left. Nothing restarts
// now, so what these cases pin is that the ONE config object every sibling reads at event
// time is the object the apply writes into.
describe("applying a config without a restart", () => {
  it("routes by the config that was stored, not the one the session started with", async () => {
    const browser = aFakeBrowser();
    const bg = await startTheBackground(browser, aFakeClock(), before);
    await browser.port.writeStored(CONFIG_STORAGE_KEY, AFTER_YAML);

    expect(await browser.receivesMessage({ type: CONFIG_APPLY })).toEqual({});

    const tab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    await browser.navigates(tab, "https://nomatch.example/");
    expect(browser.containerNameOf(await browser.tabFor("https://nomatch.example/"))).toBe("Editor");
    expect(bg.config.rules).toHaveLength(1);
  });

  it("stops routing by a rule the stored config no longer has", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), before);
    await browser.port.writeStored(CONFIG_STORAGE_KEY, AFTER_YAML);
    await browser.receivesMessage({ type: CONFIG_APPLY });

    const tab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    await browser.navigates(tab, "https://work.example/");
    // Unmatched now, so the disposable path takes it — a throwaway, not Work.
    expect(browser.containerNameOf(await browser.tabFor("https://work.example/"))).toMatch(/^tmp/);
  });

  it("re-registers content scripts, leaving one per snippet in the new config", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(
      browser,
      aFakeClock(),
      parseConfig(`rules:\n  - match: a.example\n    scripts:\n      - { run: "a();" }\n`),
    );
    await browser.port.writeStored(
      CONFIG_STORAGE_KEY,
      `rules:\n  - match: b.example\n    scripts:\n      - { run: "b();" }\n`,
    );

    await browser.receivesMessage({ type: CONFIG_APPLY });

    expect(browser.registeredScripts.map((s) => s.js[0]!.code)).toEqual(["b();"]);
  });

  it("keeps the new routing and names the failure when a snippet cannot be registered", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), before);
    await browser.port.writeStored(
      CONFIG_STORAGE_KEY,
      `rules:\n  - match: nomatch.example\n    open: Editor\n    scripts:\n      - { run: "x();" }\n`,
    );
    browser.failsContentScriptRegistration("no matching host permission");

    // Swap first, register second: storage is the truth and memory follows it. The opposite
    // order leaves the two disagreeing until the browser restarts, which is the silent
    // divergence this slice removes.
    expect(await browser.receivesMessage({ type: CONFIG_APPLY })).toEqual({
      scriptError: "no matching host permission",
    });

    const tab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    await browser.navigates(tab, "https://nomatch.example/");
    expect(browser.containerNameOf(await browser.tabFor("https://nomatch.example/"))).toBe("Editor");
  });

  it("applies the empty config and names the error when the stored text does not parse", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), before);
    await browser.port.writeStored(CONFIG_STORAGE_KEY, "rules:\n  - match: 123\n    open: Nope\n");

    const reply = (await browser.receivesMessage({ type: CONFIG_APPLY })) as { configError?: string };

    // Loud, never stale: an unparseable config routes everything to a throwaway, exactly as
    // startup does with one.
    expect(reply.configError).toBeTruthy();
    const tab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    await browser.navigates(tab, "https://work.example/");
    expect(browser.containerNameOf(await browser.tabFor("https://work.example/"))).toMatch(/^tmp/);
  });
});
```

Adapt the navigation helpers to whatever `test/engine/engine.test.ts` already uses (`browser.navigates`, `browser.tabFor`, `containerNameOf` are placeholders for the file's existing idiom — read it first and match it exactly).

- [x] **Step 2: Run and watch it fail**

Run: `npx vitest run test/engine/apply-config.test.ts`
Expected: FAIL — no `config-protocol` module, and the message is unanswered.

- [x] **Step 3: Implement**

`src/extension/config-protocol.ts`:

```ts
// The Save conversation. Shared by the options page and the wiring so neither can drift on
// the message name or the reply's shape; pure, like picker-protocol and pause-protocol.
export const CONFIG_APPLY = "cc-config-apply";

// An empty object means applied cleanly. Both fields describe a config that IS already in
// effect — the apply never refuses, because storage is the truth and memory follows it.
export interface ConfigApplyResponse {
  // A snippet in the new config failed to register. Routing follows the new config; the
  // page keeps whatever snippets the last successful apply left.
  scriptError?: string;
  // The stored text does not parse, so the EMPTY config was applied and every site opens in
  // a throwaway. Reachable through adoption only: the editor refuses to save one.
  configError?: string;
}
```

In `src/extension/wiring.ts` — import `loadConfig`, `CONFIG_STORAGE_KEY`, the protocol, add the dispatch branch and the method:

```ts
  port.onMessage((msg, sender) => {
    const type = (msg as { type?: unknown } | null | undefined)?.type;
    if (type === "cc-pick") return picker.handleMessage(msg, sender);
    if (type === CONFIG_APPLY) return applyFromMessage();
    if (typeof type === "string" && type.startsWith("cc-pause-")) return pause.handleMessage(msg);
    return undefined;
  });

  // The Save path: apply, then publish. `applyStored` deliberately does neither for adoption,
  // which is already running inside the sync queue this would re-enter.
  async function applyFromMessage(): Promise<ConfigApplyResponse> {
    const report = await applyStored();
    opts.afterApply?.();
    return report;
  }

  async function applyStored(): Promise<ConfigApplyResponse> {
    const raw = await port.readStored(CONFIG_STORAGE_KEY);
    // "" rather than the seed: by the time anything applies, storage holds the truth, and a
    // seed reachable here would be a second answer to "what is the config".
    const loaded = loadConfig(typeof raw === "string" ? raw : undefined, "");
    useConfig(loaded.config);
    const report: ConfigApplyResponse = {};
    if (loaded.error) report.configError = loaded.error.message;
    try {
      await scripts.apply(config);
    } catch (e) {
      report.scriptError = e instanceof Error ? e.message : String(e);
    }
    return report;
  }
```

Hoist the existing `useConfig` body out of the returned object literal into a named function so both callers use it, and return `applyStored` on `Background`.

- [x] **Step 4: Run**

Run: `npx vitest run test/engine && npx tsc --noEmit && npm run lint`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/extension/config-protocol.ts src/extension/wiring.ts test/engine/apply-config.test.ts
git commit -m "feat: apply a stored config in process, without restarting"
```

---

### Task 4: The editor saves without reloading

**Files:**
- Modify: `src/extension/options.ts` (header comment; the Save handler, ~line 220)

**Interfaces:**
- Consumes: `CONFIG_APPLY`, `ConfigApplyResponse` from Task 3.

- [x] **Step 1: Implement**

```ts
saveButton.addEventListener("click", () => {
  if (!validate()) return;
  void (async () => {
    // The stamp decides conflicts against other machines; the background reads it back when
    // it publishes, below.
    await writeStoredConfigYaml(textarea.value, Date.now());
    await clearReplacedConfigYaml();
    statusEl.textContent = "Saving…";

    // The status is the reply, not a prediction. It used to say "Saved — reloading" before
    // calling runtime.reload(), which on a temporarily installed extension on 140 ESR never
    // brought the background back: the old config went on routing and the page said it had
    // saved. A status stuck on "Saving…" is a message that went unanswered, which is a
    // failure someone can see.
    const report = (await browser.runtime.sendMessage({ type: CONFIG_APPLY })) as ConfigApplyResponse;
    statusEl.textContent = report.scriptError
      ? `Saved — a script could not be registered: ${report.scriptError}`
      : "Saved";

    // The page survives a save now, so what it shows about sync and about a replaced config
    // has to be brought up to date rather than rebuilt by a restart.
    await renderSyncStatus();
    await renderReplaced();
  })();
});
```

Update the file header: the third line claims saving reloads the extension.

- [x] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add src/extension/options.ts
git commit -m "feat: save the config by applying it, not by reloading"
```

---

### Task 5: Adoption applies, and the publish is re-attached

**Files:**
- Modify: `src/extension/config-sync.ts` (`browserSyncPorts`, `adopt`)
- Modify: `src/extension/background.ts`
- Modify: `src/config/sync-record.ts` (comment at ~line 164)
- Test: `test/config/` or `test/extension/` — whichever owns `config-sync`'s fake-ports suite

**Interfaces:**
- Consumes: `Background.applyStored()`.
- Produces: `browserSyncPorts(apply: () => Promise<unknown>): SyncPorts`.

- [x] **Step 1: Write the failing test**

In the existing config-sync suite, the adopt case asserts the ports' `adopt` was called; add one pinning that the applier runs after the write:

```ts
it("applies an adopted config in process rather than restarting", async () => {
  const applied: string[] = [];
  const ports = fakePorts({ /* …as the file's other cases build them… */ });
  // …drive a reconciliation that decides `adopt`…
  expect(applied).toEqual(["the remote text"]);
});
```

Match the file's existing fake-ports idiom exactly.

- [x] **Step 2: Implement**

`config-sync.ts`:

```ts
export function browserSyncPorts(apply: () => Promise<unknown>): SyncPorts {
```

```ts
      // The same apply path a Save takes; there is deliberately no second one. It used to be
      // runtime.reload(), which is the one step of an apply that nothing could observe.
      await apply();
```

`background.ts` — build the sync object first (it registers nothing until `start()`), pass the publish in, and hand adoption a deferred applier:

```ts
// Constructed before the wiring so the two can reach each other: the wiring publishes after a
// Save, and an adopted config applies through the wiring. `createConfigSync` registers no
// listener and touches no storage until `start()` runs in the tail below, so building it here
// costs nothing and keeps the listener registrations synchronous.
//
// The arrow is why the forward reference is safe: adoption cannot run before `start()`, which
// is long after `wireBackground` returned. Same shape as `picker` inside wiring.ts.
const configSync = createConfigSync(browserSyncPorts(() => background.applyStored()));

const background = wireBackground({
  port: createBrowserPort(),
  clock: realClock,
  graceMs: __CC_GRACE_MS__,
  redirectorDelayMs: __CC_REDIRECTOR_DELAY_MS__,
  // A Save used to publish by restarting: the fresh background's tail reconciled on the way
  // up. Nothing restarts now, so the apply fires the publish itself. Not awaited — a save
  // must not block on a network-backed area, and `enqueue` already serialises.
  afterApply: () => void configSync.sync(),
});
```

and the tail's last step becomes `await configSync.start();`.

`sync-record.ts`: the comment justifying "equal text never returns adopt" cites the reload. Rewrite it — the rule is unchanged, its cost is now repeated re-applies rather than repeated restarts.

- [x] **Step 3: Run**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add src/extension/config-sync.ts src/extension/background.ts src/config/sync-record.ts test/
git commit -m "feat: adopt a synced config by applying it in process"
```

---

### Task 6: Fitness — pin the reload out, and correct what a save no longer resets

**Files:**
- Modify: `test/fitness/seams.test.ts` (or `suite.test.ts`, wherever a src-wide text rule fits best)
- Modify: `test/fitness/retained-state.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it("never restarts itself to apply a config", () => {
  // The apply is in-process (2026-08-25 spec). A reload reintroduced here would take the one
  // step of a save that nothing can observe — and on a temporarily installed extension on
  // 140 ESR it does not come back at all, so the old config keeps routing while the editor
  // reports success.
  expect(pathsMatching(sourceFiles("src"), /\bruntime\.reload\b/)).toEqual([]);
});
```

- [x] **Step 2: Watch it pass, then revert-verify**

Run: `npx vitest run test/fitness`
Expected: PASS (Task 5 removed the last call). Undo Task 5's `config-sync.ts` edit in the editor, re-run, watch it go red, restore.

- [x] **Step 3: Correct `retained-state.test.ts`**

Its header says "a config save reloads the extension and empties everything", and the four-unbounded case says "In MV2 it restarts on a config save and not otherwise". Both are now false. The rows and the exact-list assertion stay; the prose becomes: nothing empties these four until the browser restarts, and each is still priced at one short string per event rarer than browsing. Note the other direction too — `reopenedNav` and the `tmp<N>` counter now survive a save, which is what stopped saving mid-reopen from costing an extra reopen.

- [x] **Step 4: Commit**

```bash
git add test/fitness
git commit -m "test: pin runtime.reload out of src and correct what a save resets"
```

---

### Task 7: The e2e case the ESR leg could not run

**Files:**
- Modify: `test/e2e/options.test.ts` (~lines 108–164)

- [x] **Step 1: Implement**

Delete the `browserVersion < 154` skip and the paragraph explaining it. Replace the fixed `sleep(2000)` with a wait on the editor's own status — the reply is the signal the old path did not have:

```ts
    it("routes by the saved config once the editor reports it applied", async () => {
      await openEditor("save");
      await typeConfig(EDITED_CONFIG);
      await firefox.driver.findElement(By.id("cc-save")).click();

      // The status is written when the background replies, so this is a real synchronisation
      // point rather than a guess at how long a restart takes. Nothing restarts: the editor
      // survives its own save now, which is also why this case runs on ESR at all.
      await firefox.driver.wait(
        async () => (await firefox.driver.findElement(By.id("cc-status")).getText()) === "Saved",
        10_000,
        "the editor never reported the config applied",
      );

      const handles = await firefox.driver.getAllWindowHandles();
      await firefox.driver.switchTo().window(handles[0]!);
```

Keep the fresh-tab polling loop below it as is — a cancelled navigation still never returns to the driver, and the poll costs nothing once the status has landed.

- [x] **Step 2: Run it on both channels**

```bash
./scripts/get-firefox.sh
FIREFOX_BIN=.firefox/esr/firefox npx vitest run test/e2e/options.test.ts
FIREFOX_BIN=.firefox/latest/firefox npx vitest run test/e2e/options.test.ts
```

Expected: PASS on both, three cases each — the ESR run is the point of the whole slice. On macOS `get-firefox.sh` fetches linux64 builds; use the mac ESR from `download.mozilla.org/?product=firefox-esr-latest-ssl&os=osx` or run this step on Linux/CI.

- [x] **Step 3: Commit**

```bash
git add test/e2e/options.test.ts
git commit -m "test: observe a config save on every channel, ESR included"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`, `FOLLOWUPS.md`, `CONFIG.md`, `src/config/default.yaml`, `configurable-containers.config.yaml`

- [x] **Step 1: CLAUDE.md**

- "Saving is a full extension restart, so every in-memory structure dies" is wrong in both halves. Replace with the apply path: one `applyStored`, the config object filled in place, the injector replacing its registrations, and what now survives a save (`handled`, `reopenedNav`, the `tmp<N>` counter). Keep `highestTmpSuffix`'s reason — a browser restart still resets the counter.
- The disposer's stored-grace paragraph cites "every save reloads": a browser restart is still the reason it is a stored fact; the F10 trigger (saving destroyed live throwaways) is now impossible for a second reason.
- The ESR line in the e2e section ("`runtime.reload()` does not bring a TEMPORARILY installed extension back on 140 ESR") stays as a measured Firefox fact, with the note that CC no longer depends on it.
- `src/extension/config-protocol.ts` joins the protocol files in "Where new logic goes".

- [x] **Step 2: FOLLOWUPS.md**

Delete the "Does a config save reach ESR users at all?" entry. Nothing is left to measure by hand: no save reloads.

- [x] **Step 3: The user-facing copy**

`CONFIG.md` and both seed configs say "Saving reloads the extension". They become "Saving applies the config immediately." Both seeds carry the same line; `test/fitness/seed-config.test.ts` may assert on seed text — run it.

- [x] **Step 4: Full gate**

```bash
npm test && npm run typecheck && npm run lint && npm run audit
```

- [x] **Step 5: Commit**

```bash
git add CLAUDE.md FOLLOWUPS.md CONFIG.md src/config/default.yaml configurable-containers.config.yaml
git commit -m "docs: describe applying a config instead of restarting"
```
